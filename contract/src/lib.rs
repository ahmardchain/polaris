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
        require!(!destination_chain.is_empty(), "destination chain required");
        require!(destination_chain.len() <= 64, "destination chain too long");
        require!(!recipient.is_empty(), "recipient required");
        require!(recipient.len() <= 128, "recipient too long");
        require!(amount.0 > 0, "amount must be positive");
        require!(coverage.0 > 0, "coverage must be positive");
        let now = env::block_timestamp();
        require!(deadline.0 > now, "deadline must be in the future");

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
        self.guarantees.insert(
            id,
            Guarantee {
                agent: env::predecessor_account_id(),
                destination_chain,
                recipient,
                amount,
                coverage,
                deadline,
                status: GuaranteeStatus::Open,
                proof_tx_hash: None,
            },
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
        require!(!tx_hash.is_empty(), "tx hash required");
        require!(tx_hash.len() <= 80, "tx hash too long");

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
        guarantee.proof_tx_hash = Some(tx_hash);
        self.outstanding_coverage -= coverage;
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
        Promise::new(agent).transfer(NearToken::from_yoctonear(coverage))
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
        contract.submit_proof(id, "0xabc".to_string());

        let guarantee = contract.get_guarantee(id).unwrap();
        assert_eq!(guarantee.status, GuaranteeStatus::Delivered);
        assert_eq!(guarantee.proof_tx_hash.as_deref(), Some("0xabc"));
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
        contract.submit_proof(id, "0xlate".to_string());
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
        contract.submit_proof(id, "0xnew".to_string());
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
}
