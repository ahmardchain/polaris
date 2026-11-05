//! Polaris guarantee.
//!
//! An agent pays a flat NEAR premium into a pool and records a cross-chain
//! payment. The pool owes the agent `coverage` if that payment is not proved
//! delivered before `deadline`. A trusted checker (set by the owner, not a
//! TEE) can submit the destination transaction hash before the deadline.
//! After the deadline anyone can claim, and the coverage is paid to the agent.
//!
//! The premium is NEAR for now. A later version can charge USDC instead.

use std::collections::BTreeMap;

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GuaranteeStatus {
    Open,
    Delivered,
    Claimed,
}

/// One purchased guarantee. `amount` is the destination payment size in that
/// chain's units (for example wei). `coverage` is the NEAR the pool pays the
/// agent if nobody proves delivery in time.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Guarantee {
    pub agent: AccountId,
    pub destination_chain: String,
    pub recipient: String,
    pub amount: U128,
    pub coverage: U128,
    pub deadline: U64,
    pub status: GuaranteeStatus,
    pub proof_tx_hash: Option<String>,
}

#[near(serializers = [json])]
pub struct PoolView {
    pub pool_balance: U128,
    pub outstanding_coverage: U128,
    /// NEAR still available to underwrite new guarantees.
    pub free_coverage: U128,
    pub premium: U128,
}

#[near(serializers = [json])]
pub struct GuaranteeEntry {
    pub id: u64,
    pub guarantee: Guarantee,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub owner: AccountId,
    pub checker: AccountId,
    pub premium: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    checker: AccountId,
    /// Flat premium, in yoctoNEAR, attached to every `buy_guarantee`.
    premium: u128,
    /// NEAR reserved for payouts and collected premiums.
    pool_balance: u128,
    /// Sum of `coverage` on guarantees that are still open.
    outstanding_coverage: u128,
    next_id: u64,
    guarantees: BTreeMap<u64, Guarantee>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(checker: AccountId, premium: U128) -> Self {
        require!(premium.0 > 0, "premium must be positive");
        Self {
            owner: env::predecessor_account_id(),
            checker,
            premium: premium.0,
            pool_balance: 0,
            outstanding_coverage: 0,
            next_id: 1,
            guarantees: BTreeMap::new(),
        }
    }

    /// Owner sets the account allowed to submit delivery proofs.
    pub fn set_checker(&mut self, checker: AccountId) {
        self.assert_owner();
        self.checker = checker;
    }

    /// Owner changes the flat premium charged on future purchases.
    pub fn set_premium(&mut self, premium: U128) {
        self.assert_owner();
        require!(premium.0 > 0, "premium must be positive");
        self.premium = premium.0;
    }

    /// Add NEAR capital to the pool. Anyone can fund it.
    #[payable]
    pub fn fund_pool(&mut self) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit > 0, "attach NEAR to fund the pool");
        self.pool_balance = self
            .pool_balance
            .checked_add(deposit)
            .expect("pool balance overflow");
    }

    /// Owner withdraws NEAR that is not backing an open guarantee.
    pub fn withdraw_surplus(&mut self, amount: U128) -> Promise {
        self.assert_owner();
        require!(amount.0 > 0, "amount must be positive");
        let surplus = self.pool_balance - self.outstanding_coverage;
        require!(amount.0 <= surplus, "cannot withdraw outstanding coverage");
        self.pool_balance -= amount.0;
        Promise::new(self.owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
    }

    /// Buy a guarantee. Attach exactly the flat premium.
    ///
    /// Refuses the purchase when `outstanding coverage + coverage` would be
    /// greater than the pool balance after the premium is added.
    #[payable]
    pub fn buy_guarantee(
        &mut self,
        destination_chain: String,
        recipient: String,
        amount: U128,
        coverage: U128,
        deadline: U64,
    ) -> u64 {
        let destination_chain = clean_chain(destination_chain);
        let recipient = clean_recipient(recipient);
        require!(amount.0 > 0, "amount must be positive");
        require!(coverage.0 > 0, "coverage must be positive");
        let now = env::block_timestamp();
        require!(deadline.0 > now, "deadline must be in the future");
        require!(
            deadline.0 - now <= MAX_DEADLINE_NS,
            "deadline must be within 30 days"
        );

        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit == self.premium,
            "must attach exactly the flat premium"
        );

        let new_pool = self
            .pool_balance
            .checked_add(deposit)
            .expect("pool balance overflow");
        let new_outstanding = self
            .outstanding_coverage
            .checked_add(coverage.0)
            .expect("coverage overflow");
        require!(
            new_outstanding <= new_pool,
            "pool cap: outstanding coverage would exceed pool balance"
        );

        let id = self.next_id;
        self.next_id = self.next_id.checked_add(1).expect("id overflow");
        self.pool_balance = new_pool;
        self.outstanding_coverage = new_outstanding;
        let agent = env::predecessor_account_id();
        self.guarantees.insert(
            id,
            Guarantee {
                agent: agent.clone(),
                destination_chain,
                recipient,
                amount,
                coverage,
                deadline,
                status: GuaranteeStatus::Open,
                proof_tx_hash: None,
            },
        );
        emit(
            "buy_guarantee",
            &format!(
                "{{\"id\":{id},\"agent\":\"{agent}\",\"coverage\":\"{}\"}}",
                coverage.0
            ),
        );
        id
    }

    /// Checker marks the payment delivered. The premium stays in the pool and
    /// the coverage is no longer outstanding. Rejected at or after the deadline.
    pub fn submit_proof(&mut self, guarantee_id: u64, tx_hash: String) {
        require!(
            env::predecessor_account_id() == self.checker,
            "only the checker"
        );
        let tx_hash = clean_tx_hash(tx_hash);

        let guarantee = self
            .guarantees
            .get_mut(&guarantee_id)
            .expect("guarantee not found");
        match guarantee.status {
            GuaranteeStatus::Delivered => env::panic_str("already delivered"),
            GuaranteeStatus::Claimed => env::panic_str("already claimed"),
            GuaranteeStatus::Open => {}
        }
        require!(
            env::block_timestamp() < guarantee.deadline.0,
            "late proof rejected"
        );

        let coverage = guarantee.coverage.0;
        guarantee.status = GuaranteeStatus::Delivered;
        guarantee.proof_tx_hash = Some(tx_hash.clone());
        self.outstanding_coverage -= coverage;
        emit(
            "submit_proof",
            &format!("{{\"id\":{guarantee_id},\"tx_hash\":\"{tx_hash}\"}}"),
        );
    }

    /// After the deadline, pay `coverage` to the agent unless delivery was proved.
    /// Anyone can call this. A second call is rejected.
    pub fn claim(&mut self, guarantee_id: u64) -> Promise {
        let guarantee = self
            .guarantees
            .get_mut(&guarantee_id)
            .expect("guarantee not found");
        match guarantee.status {
            GuaranteeStatus::Delivered => env::panic_str("already delivered"),
            GuaranteeStatus::Claimed => env::panic_str("already claimed"),
            GuaranteeStatus::Open => {}
        }
        require!(
            env::block_timestamp() >= guarantee.deadline.0,
            "deadline has not passed"
        );

        let coverage = guarantee.coverage.0;
        let agent = guarantee.agent.clone();
        guarantee.status = GuaranteeStatus::Claimed;
        self.outstanding_coverage -= coverage;
        self.pool_balance -= coverage;
        emit(
            "claim",
            &format!("{{\"id\":{guarantee_id},\"agent\":\"{agent}\",\"coverage\":\"{coverage}\"}}"),
        );
        Promise::new(agent).transfer(NearToken::from_yoctonear(coverage))
    }

    /// Guarantees in id order. `from_index` is an offset, not an id. `limit` is 1..=50.
    pub fn get_guarantees(&self, from_index: u64, limit: u64) -> Vec<GuaranteeEntry> {
        require!(limit > 0 && limit <= 50, "limit must be 1..=50");
        self.guarantees
            .iter()
            .skip(from_index as usize)
            .take(limit as usize)
            .map(|(id, guarantee)| GuaranteeEntry {
                id: *id,
                guarantee: guarantee.clone(),
            })
            .collect()
    }

    pub fn get_next_id(&self) -> u64 {
        self.next_id
    }

    pub fn get_guarantee(&self, guarantee_id: u64) -> Option<Guarantee> {
        self.guarantees.get(&guarantee_id).cloned()
    }

    pub fn get_pool(&self) -> PoolView {
        PoolView {
            pool_balance: U128(self.pool_balance),
            outstanding_coverage: U128(self.outstanding_coverage),
            free_coverage: U128(self.pool_balance - self.outstanding_coverage),
            premium: U128(self.premium),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            checker: self.checker.clone(),
            premium: U128(self.premium),
        }
    }
}

const MAX_DEADLINE_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;

fn emit(event: &str, data: &str) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"polaris-guarantee\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":[{data}]}}"
    ));
}

fn clean_chain(value: String) -> String {
    let value = value.trim().to_string();
    require!(!value.is_empty(), "destination chain required");
    require!(value.len() <= 64, "destination chain too long");
    require!(
        value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
        "destination chain must be lowercase letters, digits, or hyphens"
    );
    value
}

fn clean_recipient(value: String) -> String {
    let value = value.trim().to_string();
    require!(!value.is_empty(), "recipient required");
    require!(value.len() <= 128, "recipient too long");
    require!(
        !value.chars().any(|c| c.is_whitespace()),
        "recipient must not contain whitespace"
    );
    value
}

fn clean_tx_hash(value: String) -> String {
    let value = value.trim().to_string();
    require!(!value.is_empty(), "tx hash required");
    require!(value.len() <= 80, "tx hash too long");
    require!(
        !value.chars().any(|c| c.is_whitespace()),
        "tx hash must not contain whitespace"
    );
    if let Some(hex) = value.strip_prefix("0x") {
        require!(
            hex.len() == 64 && hex.chars().all(|c| c.is_ascii_hexdigit()),
            "evm tx hash must be 0x plus 64 hex characters"
        );
    }
    value
}

impl Contract {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};

    const TX: &str = "0x4546eed3b02239a3bea9646ea3ddf59b8b82787d726effe92662c8bd67e5ba9e";
    const YOCTO: u128 = 1_000_000_000_000_000_000_000_000;
    const PREMIUM: u128 = YOCTO;
    const COVERAGE: u128 = 10 * YOCTO;
    const NOW: u64 = 1_700_000_000_000_000_000;

    fn yocto(near: u128) -> u128 {
        near * YOCTO
    }

    fn context(caller: &str, deposit: u128, timestamp: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id("guarantee.testnet".parse().unwrap())
            .predecessor_account_id(caller.parse().unwrap())
            .signer_account_id(caller.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(timestamp)
            .account_balance(NearToken::from_near(100));
        testing_env!(builder.build());
    }

    fn init() -> Contract {
        context("owner.testnet", 0, NOW);
        Contract::new("checker.testnet".parse().unwrap(), U128(PREMIUM))
    }

    fn fund(contract: &mut Contract, amount: u128) {
        context("owner.testnet", amount, NOW);
        contract.fund_pool();
    }

    fn buy(contract: &mut Contract, caller: &str, coverage: u128, deadline: u64) -> u64 {
        context(caller, PREMIUM, NOW);
        contract.buy_guarantee(
            "ethereum-sepolia".to_string(),
            "0x6Fed7c2dfCB2a08d36Cd1969c3107C0Be48BEDc6".to_string(),
            U128(1),
            U128(coverage),
            U64(deadline),
        )
    }

    #[test]
    fn delivered_keeps_premium_and_releases_coverage() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        let deadline = NOW + 60_000_000_000;
        let id = buy(&mut contract, "agent.testnet", COVERAGE, deadline);

        context("checker.testnet", 0, NOW + 1_000);
        contract.submit_proof(id, TX.to_string());

        let guarantee = contract.get_guarantee(id).unwrap();
        assert_eq!(guarantee.status, GuaranteeStatus::Delivered);
        assert_eq!(guarantee.proof_tx_hash.as_deref(), Some(TX));
        assert_eq!(guarantee.agent.as_str(), "agent.testnet");
        let pool = contract.get_pool();
        assert_eq!(pool.outstanding_coverage.0, 0);
        // Seed plus the premium. Nothing was paid out.
        assert_eq!(pool.pool_balance.0, yocto(20) + PREMIUM);
        assert_eq!(pool.free_coverage.0, yocto(20) + PREMIUM);

        context("anyone.testnet", 0, deadline + 1);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = contract.claim(id);
        }));
        assert!(caught.is_err());
        assert_eq!(
            contract.get_guarantee(id).unwrap().status,
            GuaranteeStatus::Delivered
        );
    }

    #[test]
    fn timed_out_claim_pays_coverage_from_the_pool() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        let deadline = NOW + 60_000_000_000;
        let id = buy(&mut contract, "agent.testnet", COVERAGE, deadline);

        context("anyone.testnet", 0, deadline);
        let _ = contract.claim(id);

        let guarantee = contract.get_guarantee(id).unwrap();
        assert_eq!(guarantee.status, GuaranteeStatus::Claimed);
        assert_eq!(guarantee.agent.as_str(), "agent.testnet");
        let pool = contract.get_pool();
        assert_eq!(pool.outstanding_coverage.0, 0);
        // 20 funded + 1 premium - 10 coverage.
        assert_eq!(pool.pool_balance.0, yocto(20) + PREMIUM - COVERAGE);
    }

    #[test]
    #[should_panic(expected = "late proof rejected")]
    fn late_proof_is_rejected() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        let deadline = NOW + 60_000_000_000;
        let id = buy(&mut contract, "agent.testnet", COVERAGE, deadline);
        context("checker.testnet", 0, deadline);
        contract.submit_proof(id, TX.to_string());
    }

    #[test]
    #[should_panic(expected = "pool cap: outstanding coverage would exceed pool balance")]
    fn cap_exceeded_refuses_the_purchase() {
        let mut contract = init();
        fund(&mut contract, yocto(5));
        // Pool after the premium would be 6 NEAR. Coverage of 10 does not fit.
        buy(
            &mut contract,
            "agent.testnet",
            yocto(10),
            NOW + 60_000_000_000,
        );
    }

    #[test]
    fn cap_exceeded_does_not_record_a_guarantee() {
        let mut contract = init();
        fund(&mut contract, yocto(5));
        let before = contract.get_pool();
        context("agent.testnet", PREMIUM, NOW);
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.buy_guarantee(
                "ethereum-sepolia".to_string(),
                "0xabc".to_string(),
                U128(1),
                U128(yocto(10)),
                U64(NOW + 60_000_000_000),
            );
        }));
        assert!(caught.is_err());
        let after = contract.get_pool();
        assert_eq!(after.pool_balance.0, before.pool_balance.0);
        assert_eq!(after.outstanding_coverage.0, 0);
        assert!(contract.get_guarantee(1).is_none());
    }

    #[test]
    #[should_panic(expected = "already claimed")]
    fn double_claim_is_rejected() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        let deadline = NOW + 60_000_000_000;
        let id = buy(&mut contract, "agent.testnet", COVERAGE, deadline);
        context("anyone.testnet", 0, deadline);
        let _ = contract.claim(id);
        context("anyone.testnet", 0, deadline + 1);
        let _ = contract.claim(id);
    }

    #[test]
    #[should_panic(expected = "only the checker")]
    fn proof_from_another_account_is_rejected() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        let id = buy(
            &mut contract,
            "agent.testnet",
            COVERAGE,
            NOW + 60_000_000_000,
        );
        context("agent.testnet", 0, NOW + 1);
        contract.submit_proof(id, "0xnope".to_string());
    }

    #[test]
    #[should_panic(expected = "deadline has not passed")]
    fn claim_before_deadline_is_rejected() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        let id = buy(
            &mut contract,
            "agent.testnet",
            COVERAGE,
            NOW + 60_000_000_000,
        );
        context("agent.testnet", 0, NOW + 1);
        let _ = contract.claim(id);
    }

    #[test]
    fn owner_can_replace_the_checker() {
        let mut contract = init();
        context("owner.testnet", 0, NOW);
        contract.set_checker("new-checker.testnet".parse().unwrap());
        assert_eq!(
            contract.get_config().checker.as_str(),
            "new-checker.testnet"
        );

        fund(&mut contract, yocto(20));
        let id = buy(
            &mut contract,
            "agent.testnet",
            COVERAGE,
            NOW + 60_000_000_000,
        );
        context("new-checker.testnet", 0, NOW + 1);
        contract.submit_proof(id, TX.to_string());
        assert_eq!(
            contract.get_guarantee(id).unwrap().status,
            GuaranteeStatus::Delivered
        );
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn non_owner_cannot_set_the_checker() {
        let mut contract = init();
        context("agent.testnet", 0, NOW);
        contract.set_checker("other.testnet".parse().unwrap());
    }

    #[test]
    #[should_panic(expected = "destination chain must be lowercase")]
    fn uppercase_chain_is_rejected() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        context("agent.testnet", PREMIUM, NOW);
        contract.buy_guarantee(
            "Ethereum".to_string(),
            "0xabc".to_string(),
            U128(1),
            U128(COVERAGE),
            U64(NOW + 60_000_000_000),
        );
    }

    #[test]
    #[should_panic(expected = "evm tx hash must be 0x plus 64 hex characters")]
    fn short_evm_hash_is_rejected() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        let id = buy(
            &mut contract,
            "agent.testnet",
            COVERAGE,
            NOW + 60_000_000_000,
        );
        context("checker.testnet", 0, NOW + 1);
        contract.submit_proof(id, "0xabc".to_string());
    }

    #[test]
    #[should_panic(expected = "deadline must be within 30 days")]
    fn distant_deadline_is_rejected() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        buy(
            &mut contract,
            "agent.testnet",
            COVERAGE,
            NOW + 31 * 24 * 60 * 60 * 1_000_000_000,
        );
    }

    #[test]
    #[should_panic(expected = "attach NEAR to fund the pool")]
    fn empty_fund_is_rejected() {
        let mut contract = init();
        context("owner.testnet", 0, NOW);
        contract.fund_pool();
    }

    #[test]
    #[should_panic(expected = "cannot withdraw outstanding coverage")]
    fn surplus_withdraw_cannot_touch_open_coverage() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        buy(
            &mut contract,
            "agent.testnet",
            COVERAGE,
            NOW + 60_000_000_000,
        );
        context("owner.testnet", 0, NOW);
        let _ = contract.withdraw_surplus(U128(yocto(20)));
    }

    #[test]
    fn list_guarantees_and_buy_event() {
        let mut contract = init();
        fund(&mut contract, yocto(20));
        let id = buy(
            &mut contract,
            "agent.testnet",
            COVERAGE,
            NOW + 60_000_000_000,
        );
        let page = contract.get_guarantees(0, 10);
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, id);
        assert_eq!(page[0].guarantee.status, GuaranteeStatus::Open);
        assert_eq!(contract.get_next_id(), id + 1);
        assert!(contract.get_guarantees(1, 10).is_empty());
        let logs = near_sdk::test_utils::get_logs();
        assert!(logs.iter().any(|line| line.contains("buy_guarantee")));
    }

    #[test]
    #[should_panic(expected = "limit must be 1..=50")]
    fn list_limit_zero_is_rejected() {
        let contract = init();
        contract.get_guarantees(0, 0);
    }
}
