#![no_std]

extern crate alloc;

mod merkle;
mod verifier;

use alloc::string::String;
use soroban_sdk::{contractimpl, contracterror, panic_with_error, Address, Env, Symbol, BytesN, vec, Vec};
use soroban_sdk::storage::Persistent;
use soroban_sdk::token::Client as TokenClient;

use merkle as merkle_mod;
use verifier as verifier_mod;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum PoolError {
    AlreadyInitialized,
    NotAdmin,
    AssetNotSupported,
    NullifierAlreadyUsed,
    StaleRoot,
    InvalidProof,
    ContractPaused,
    InvalidAmount,
}

fn initialized_key() -> Symbol { Symbol::new("INITIALIZED") }
fn paused_key() -> Symbol { Symbol::new("PAUSED") }
fn admin_key() -> Symbol { Symbol::new("ADMIN") }
fn nullifier_key(b: &BytesN<32>) -> Symbol {
    // key per nullifier
    let s = hex::encode(b.to_array());
    Symbol::new(&alloc::format!("NULL_{}", s))
}
fn supported_assets_key() -> Symbol { Symbol::new("SUPPORTED_ASSETS") }

fn is_admin(env: &Env, caller: &Address) -> bool {
    let p: Persistent<Address> = Persistent::new(env, &admin_key());
    if let Ok(Some(admin)) = p.get() {
        &admin == caller
    } else {
        false
    }
}

fn check_paused(env: &Env) -> bool {
    let p: Persistent<bool> = Persistent::new(env, &paused_key());
    match p.get().ok().flatten() {
        Some(v) => v,
        None => false,
    }
}

#[contractimpl]
impl ShieldPool {
    pub fn initialize(env: Env, admin: Address, supported_assets: Vec<Address>) {
        let init_p: Persistent<bool> = Persistent::new(&env, &initialized_key());
        if init_p.get().ok().flatten().unwrap_or(false) {
            panic_with_error!(&env, PoolError::AlreadyInitialized);
        }

        // set admin
        let admin_p: Persistent<Address> = Persistent::new(&env, &admin_key());
        let _ = admin_p.set(&admin);

        // set supported assets
        let assets_p: Persistent<Vec<Address>> = Persistent::new(&env, &supported_assets_key());
        let _ = assets_p.set(&supported_assets);

        // initialize merkle
        let _ = merkle_mod::ensure_zeros(&env);

        let _ = init_p.set(&true);
    }

    pub fn pause(env: Env, caller: Address) {
        if !is_admin(&env, &caller) { panic_with_error!(&env, PoolError::NotAdmin); }
        let p: Persistent<bool> = Persistent::new(&env, &paused_key());
        let _ = p.set(&true);
    }

    pub fn unpause(env: Env, caller: Address) {
        if !is_admin(&env, &caller) { panic_with_error!(&env, PoolError::NotAdmin); }
        let p: Persistent<bool> = Persistent::new(&env, &paused_key());
        let _ = p.set(&false);
    }

    pub fn add_asset(env: Env, caller: Address, asset: Address) {
        if !is_admin(&env, &caller) { panic_with_error!(&env, PoolError::NotAdmin); }
        let assets_p: Persistent<Vec<Address>> = Persistent::new(&env, &supported_assets_key());
        let mut assets = assets_p.get().ok().flatten().unwrap_or_else(|| Vec::new(&env));
        assets.push_back(asset.clone());
        let _ = assets_p.set(&assets);
    }

    pub fn deposit(
        env: Env,
        depositor: Address,
        asset: Address,
        amount: i128,
        commitment: BytesN<32>,
        proof_a: (BytesN<32>, BytesN<32>),
        proof_b: (BytesN<32>, BytesN<32>, BytesN<32>, BytesN<32>),
        proof_c: (BytesN<32>, BytesN<32>),
    ) -> u32 {
        if check_paused(&env) { panic_with_error!(&env, PoolError::ContractPaused); }
        if amount <= 0 { panic_with_error!(&env, PoolError::InvalidAmount); }

        // depositor must authorize
        depositor.require_auth();

        // check asset supported
        let assets_p: Persistent<Vec<Address>> = Persistent::new(&env, &supported_assets_key());
        let assets = assets_p.get().ok().flatten().unwrap_or_else(|| Vec::new(&env));
        let mut supported = false;
        for i in 0..assets.len() {
            if let Some(a) = assets.get(i) {
                if a == &asset { supported = true; break; }
            }
        }
        if !supported { panic_with_error!(&env, PoolError::AssetNotSupported); }

        // Verify ZK proof
        // Build verifier::Proof from tuples
        let proof = verifier_mod::Proof {
            a: (proof_a.0.to_array(), proof_a.1.to_array()),
            b: (proof_b.0.to_array(), proof_b.1.to_array(), proof_b.2.to_array(), proof_b.3.to_array()),
            c: (proof_c.0.to_array(), proof_c.1.to_array()),
        };

        // Public inputs ordering for deposit: [commitment, amount, asset_id]
        // We'll interpret asset Address into an asset_id BytesN<32> via env hash or address serialization
        let asset_id = BytesN::from_array(&env, &asset.serialize());
        let commitment_u = commitment.to_array();
        let amount_u = i128_to_u256(amount);

        let ok = verifier_mod::verify_deposit_proof(&env, &verifier_mod::VerifyingKey {
            alpha: ([0u8;32],[0u8;32]),
            beta: ([0u8;32],[0u8;32],[0u8;32],[0u8;32]),
            gamma: ([0u8;32],[0u8;32],[0u8;32],[0u8;32]),
            delta: ([0u8;32],[0u8;32],[0u8;32],[0u8;32]),
            ic: Vec::new(&env),
        }, &proof, commitment_u, amount_u, asset_id.to_array());

        if !ok { panic_with_error!(&env, PoolError::InvalidProof); }

        // Transfer tokens from depositor to this contract
        let client = TokenClient::new(&env, &asset);
        let contract_address = Address::Contract(env.get_current_contract());
        let _ = client.transfer(&depositor, &contract_address, &amount);

        // Insert commitment into Merkle tree
        let (leaf_index, _root) = merkle_mod::insert(&env, commitment.clone());

        // Emit event (use log via env.events)
        let mut ev = env.events();
        ev.publish((Symbol::new("deposit"),), vec![commitment.clone().into(), leaf_index].into());

        leaf_index
    }

    pub fn transfer(
        env: Env,
        nullifier: BytesN<32>,
        new_commitment: BytesN<32>,
        merkle_root: BytesN<32>,
        asset_id: BytesN<32>,
        proof_a: (BytesN<32>, BytesN<32>),
        proof_b: (BytesN<32>, BytesN<32>, BytesN<32>, BytesN<32>),
        proof_c: (BytesN<32>, BytesN<32>),
    ) {
        if check_paused(&env) { panic_with_error!(&env, PoolError::ContractPaused); }

        // Verify merkle_root known
        if !merkle_mod::known_root(&env, merkle_root.clone()) { panic_with_error!(&env, PoolError::StaleRoot); }

        // Check nullifier unused
        let null_sym = nullifier_key(&nullifier);
        let null_p: Persistent<bool> = Persistent::new(&env, &null_sym);
        if null_p.get().ok().flatten().unwrap_or(false) { panic_with_error!(&env, PoolError::NullifierAlreadyUsed); }

        // Build proof
        let proof = verifier_mod::Proof {
            a: (proof_a.0.to_array(), proof_a.1.to_array()),
            b: (proof_b.0.to_array(), proof_b.1.to_array(), proof_b.2.to_array(), proof_b.3.to_array()),
            c: (proof_c.0.to_array(), proof_c.1.to_array()),
        };

        // Public inputs order for transfer: [nullifier, new_commitment, merkle_root, asset_id]
        let ok = verifier_mod::verify_transfer_proof(&env, &verifier_mod::VerifyingKey {
            alpha: ([0u8;32],[0u8;32]),
            beta: ([0u8;32],[0u8;32],[0u8;32],[0u8;32]),
            gamma: ([0u8;32],[0u8;32],[0u8;32],[0u8;32]),
            delta: ([0u8;32],[0u8;32],[0u8;32],[0u8;32]),
            ic: Vec::new(&env),
        }, &proof, nullifier.to_array(), new_commitment.to_array(), merkle_root.to_array(), asset_id.to_array());

        if !ok { panic_with_error!(&env, PoolError::InvalidProof); }

        // Mark nullifier used
        let _ = null_p.set(&true);

        // Insert new commitment
        let (_leaf_index, _root) = merkle_mod::insert(&env, new_commitment.clone());

        // Emit events
        let mut ev = env.events();
        ev.publish((Symbol::new("nullified"),), vec![nullifier.clone().into()].into());
        ev.publish((Symbol::new("commitment"),), vec![new_commitment.clone().into()].into());
    }

    pub fn withdraw(
        env: Env,
        nullifier: BytesN<32>,
        merkle_root: BytesN<32>,
        recipient: Address,
        asset: Address,
        amount: i128,
        proof_a: (BytesN<32>, BytesN<32>),
        proof_b: (BytesN<32>, BytesN<32>, BytesN<32>, BytesN<32>),
        proof_c: (BytesN<32>, BytesN<32>),
    ) {
        if check_paused(&env) { panic_with_error!(&env, PoolError::ContractPaused); }
        if amount <= 0 { panic_with_error!(&env, PoolError::InvalidAmount); }

        if !merkle_mod::known_root(&env, merkle_root.clone()) { panic_with_error!(&env, PoolError::StaleRoot); }

        // Check nullifier unused
        let null_sym = nullifier_key(&nullifier);
        let null_p: Persistent<bool> = Persistent::new(&env, &null_sym);
        if null_p.get().ok().flatten().unwrap_or(false) { panic_with_error!(&env, PoolError::NullifierAlreadyUsed); }

        // Build proof
        let proof = verifier_mod::Proof {
            a: (proof_a.0.to_array(), proof_a.1.to_array()),
            b: (proof_b.0.to_array(), proof_b.1.to_array(), proof_b.2.to_array(), proof_b.3.to_array()),
            c: (proof_c.0.to_array(), proof_c.1.to_array()),
        };

        // Public inputs ordering for withdraw: [nullifier, merkle_root, recipient, amount, asset_id]
        let asset_id = BytesN::from_array(&env, &asset.serialize());
        let ok = verifier_mod::verify_withdraw_proof(&env, &verifier_mod::VerifyingKey {
            alpha: ([0u8;32],[0u8;32]),
            beta: ([0u8;32],[0u8;32],[0u8;32],[0u8;32]),
            gamma: ([0u8;32],[0u8;32],[0u8;32],[0u8;32]),
            delta: ([0u8;32],[0u8;32],[0u8;32],[0u8;32]),
            ic: Vec::new(&env),
        }, &proof, nullifier.to_array(), merkle_root.to_array(), BytesN::from_array(&env, &recipient.serialize()).to_array(), i128_to_u256(amount), asset_id.to_array());

        if !ok { panic_with_error!(&env, PoolError::InvalidProof); }

        // Mark nullifier used
        let _ = null_p.set(&true);

        // Transfer asset out
        let client = TokenClient::new(&env, &asset);
        let contract_address = Address::Contract(env.get_current_contract());
        let _ = client.transfer(&contract_address, &recipient, &amount);

        // Emit event
        let mut ev = env.events();
        ev.publish((Symbol::new("withdraw"),), vec![recipient.clone().into(), amount].into());
    }
}

pub struct ShieldPool;

// Helper: convert i128 to U256 byte array (big endian). Saturates on negative.
fn i128_to_u256(v: i128) -> [u8;32] {
    let mut out = [0u8;32];
    if v < 0 { return out; }
    let mut x = v as u128; // assume non-negative
    for i in 0..16 {
        out[31 - i] = (x & 0xff) as u8;
        x >>= 8;
    }
    out
}
// shield_pool crate

pub fn hello_shield() -> &'static str {
    "shield_pool: not implemented"
}
