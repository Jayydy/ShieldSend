//! ASP (Association Set Provider) Compliance Contract
//!
//! v1: On-chain Poseidon Merkle membership verification.
//! v2 (planned): ZK non-membership proofs for blocklist to hide who is checked.
//!
//! Storage layout (Persistent):
//!   "INITIALIZED"        → bool
//!   "ADMIN"              → Address
//!   "SHIELD_POOL"        → Address
//!   "AL_ROOT"            → BytesN<32>   allowlist Merkle root
//!   "AL_SIZE"            → u32          allowlist leaf count
//!   "AL_NODE_{l}_{i}"   → BytesN<32>   allowlist tree node at (level, index)
//!   "AL_ZEROS_{i}"       → BytesN<32>   precomputed zero hashes for allowlist
//!   "BL_ROOT"            → BytesN<32>   blocklist Merkle root
//!   "BL_SIZE"            → u32          blocklist leaf count
//!   "BL_NODE_{l}_{i}"   → BytesN<32>   blocklist tree node at (level, index)
//!   "BL_ZEROS_{i}"       → BytesN<32>   precomputed zero hashes for blocklist

#![no_std]
extern crate alloc;

use alloc::format;
use soroban_sdk::{
    contractimpl, contracterror, panic_with_error,
    Address, BytesN, Env, Symbol, Vec,
};
use soroban_sdk::storage::Persistent;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum AspError {
    AlreadyInitialized = 1,
    NotAdmin           = 2,
    HashUnavailable    = 3,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn sym(s: &str) -> Symbol { Symbol::new(s) }

fn get<T: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(env: &Env, key: &Symbol) -> Option<T> {
    let p: Persistent<T> = Persistent::new(env, key);
    p.get().ok().flatten()
}

fn set<T: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &Symbol, val: &T) {
    let p: Persistent<T> = Persistent::new(env, key);
    let _ = p.set(val);
}

// ---------------------------------------------------------------------------
// Poseidon2 wrapper (Protocol 25 native host function)
// ---------------------------------------------------------------------------

fn poseidon2(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> Option<BytesN<32>> {
    use soroban_sdk::native_contract::crypto::Client as CryptoClient;
    use core::convert::TryInto;
    let client = CryptoClient::new(env);
    let res = client.invoke(
        &sym("poseidon2_hash"),
        soroban_sdk::vec![env, left.clone().into(), right.clone().into()],
    );
    match res {
        Ok(v) => v.try_into().ok(),
        Err(_) => None,
    }
}

// ---------------------------------------------------------------------------
// Minimal Merkle tree (depth 20) — parameterised by key prefix
// ---------------------------------------------------------------------------

const DEPTH: usize = 20;

struct Tree<'a> {
    env:    &'a Env,
    prefix: &'a str,   // "AL" or "BL"
}

impl<'a> Tree<'a> {
    fn new(env: &'a Env, prefix: &'a str) -> Self { Self { env, prefix } }

    fn root_key(&self)         -> Symbol { sym(&format!("{}_ROOT", self.prefix)) }
    fn size_key(&self)         -> Symbol { sym(&format!("{}_SIZE", self.prefix)) }
    fn node_key(&self, l: usize, i: u32) -> Symbol {
        sym(&format!("{}_NODE_{}_{}", self.prefix, l, i))
    }
    fn zero_key(&self, i: usize) -> Symbol {
        sym(&format!("{}_ZEROS_{}", self.prefix, i))
    }

    fn get_root(&self) -> BytesN<32> {
        get(self.env, &self.root_key())
            .unwrap_or_else(|| BytesN::from_array(self.env, &[0u8; 32]))
    }

    fn get_zero(&self, i: usize) -> Option<BytesN<32>> {
        get(self.env, &self.zero_key(i))
    }

    /// Lazily compute and cache the zero hashes for levels 0..DEPTH.
    fn ensure_zeros(&self) -> Option<Vec<BytesN<32>>> {
        let mut zeros: Vec<BytesN<32>> = Vec::new(self.env);
        for i in 0..DEPTH {
            if let Some(z) = self.get_zero(i) {
                zeros.push_back(z);
                continue;
            }
            let h = if i == 0 {
                let z = BytesN::from_array(self.env, &[0u8; 32]);
                poseidon2(self.env, &z, &z)?
            } else {
                let prev = zeros.get((i - 1) as u32)?.clone();
                poseidon2(self.env, &prev, &prev)?
            };
            set(self.env, &self.zero_key(i), &h);
            zeros.push_back(h);
        }
        Some(zeros)
    }

    /// Insert a leaf; returns (leaf_index, new_root). Panics with HashUnavailable if Poseidon missing.
    fn insert(&self, env: &Env, leaf: BytesN<32>) -> (u32, BytesN<32>) {
        let zeros = match self.ensure_zeros() {
            Some(z) => z,
            None => panic_with_error!(env, AspError::HashUnavailable),
        };

        let leaf_index: u32 = get(env, &self.size_key()).unwrap_or(0);
        set(env, &self.node_key(0, leaf_index), &leaf);

        let mut current = leaf;
        let mut index = leaf_index;

        for level in 0..DEPTH {
            let sib_index = if index % 2 == 0 { index + 1 } else { index - 1 };
            let sibling: BytesN<32> = get(env, &self.node_key(level, sib_index))
                .unwrap_or_else(|| zeros.get(level as u32).unwrap().clone());

            let (left, right) = if index % 2 == 0 {
                (current.clone(), sibling)
            } else {
                (sibling, current.clone())
            };

            let parent = match poseidon2(env, &left, &right) {
                Some(h) => h,
                None => panic_with_error!(env, AspError::HashUnavailable),
            };
            set(env, &self.node_key(level + 1, index / 2), &parent);
            current = parent;
            index /= 2;
        }

        set(env, &self.root_key(), &current);
        set(env, &self.size_key(), &(leaf_index + 1));
        (leaf_index, current)
    }

    /// Verify a Merkle inclusion proof: leaf → path_elements/indices → root.
    ///
    /// path_indices[i] = 0 means the leaf is on the LEFT at level i (sibling is right).
    /// path_indices[i] = 1 means the leaf is on the RIGHT.
    fn verify_proof(
        &self,
        leaf:          BytesN<32>,
        path_elements: &Vec<BytesN<32>>,
        path_indices:  &Vec<u32>,
        root:          &BytesN<32>,
    ) -> bool {
        if path_elements.len() != path_indices.len() {
            return false;
        }

        let mut current = leaf;
        let len = path_elements.len();
        for i in 0..len {
            let sib = match path_elements.get(i) {
                Some(v) => v.clone(),
                None => return false,
            };
            let side = match path_indices.get(i) {
                Some(v) => *v,
                None => return false,
            };
            let (left, right) = if side == 0 {
                (current.clone(), sib)
            } else {
                (sib, current.clone())
            };
            current = match poseidon2(self.env, &left, &right) {
                Some(h) => h,
                None => return false,
            };
        }
        &current == root
    }
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

pub struct Asp;

#[contractimpl]
impl Asp {
    /// One-time initialisation. Sets admin and the ShieldPool address that
    /// is authorised to call is_eligible().
    pub fn initialize(env: Env, admin: Address, shield_pool: Address) {
        if get::<bool>(&env, &sym("INITIALIZED")).unwrap_or(false) {
            panic_with_error!(&env, AspError::AlreadyInitialized);
        }
        set(&env, &sym("ADMIN"),       &admin);
        set(&env, &sym("SHIELD_POOL"), &shield_pool);
        // Eagerly cache zero hashes so first insert is cheaper.
        Tree::new(&env, "AL").ensure_zeros();
        Tree::new(&env, "BL").ensure_zeros();
        set(&env, &sym("INITIALIZED"), &true);
    }

    // -----------------------------------------------------------------------
    // Admin mutations
    // -----------------------------------------------------------------------

    /// Add a commitment to the allowlist Merkle tree.
    ///
    /// In production this is called by a KYC oracle or trusted issuer.
    /// For the hackathon demo the admin can allowlist any commitment directly.
    pub fn add_to_allowlist(env: Env, caller: Address, commitment: BytesN<32>) {
        Self::require_admin(&env, &caller);
        Tree::new(&env, "AL").insert(&env, commitment);
    }

    /// Add a commitment to the blocklist Merkle tree.
    ///
    /// v1: on-chain Merkle insertion (blocklist membership is publicly observable).
    /// v2 (planned): replace with ZK non-membership proofs so that a prover
    ///   can prove "my commitment is NOT in the blocklist" without revealing
    ///   which blocklist entry was checked.
    pub fn add_to_blocklist(env: Env, caller: Address, commitment: BytesN<32>) {
        Self::require_admin(&env, &caller);
        Tree::new(&env, "BL").insert(&env, commitment);
    }

    // -----------------------------------------------------------------------
    // Root queries
    // -----------------------------------------------------------------------

    pub fn get_allowlist_root(env: Env) -> BytesN<32> {
        Tree::new(&env, "AL").get_root()
    }

    pub fn get_blocklist_root(env: Env) -> BytesN<32> {
        Tree::new(&env, "BL").get_root()
    }

    // -----------------------------------------------------------------------
    // Eligibility check
    // -----------------------------------------------------------------------

    /// Returns true iff `commitment` has a valid Merkle proof of membership
    /// in the current allowlist root.
    ///
    /// NOTE (v1 limitation): This does NOT check the blocklist with a ZK proof.
    /// Blocklist checks in v1 are performed off-chain by the frontend before
    /// submitting a transaction, and the admin is responsible for keeping the
    /// blocklist up-to-date. A v2 ZK non-membership proof will enforce this
    /// on-chain without revealing which entry was examined.
    ///
    /// Called by ShieldPool before accepting a deposit from a new user.
    pub fn is_eligible(
        env:              Env,
        commitment:       BytesN<32>,
        allowlist_proof:  Vec<BytesN<32>>,
        allowlist_indices: Vec<u32>,
    ) -> bool {
        let root = Tree::new(&env, "AL").get_root();
        Tree::new(&env, "AL").verify_proof(
            commitment,
            &allowlist_proof,
            &allowlist_indices,
            &root,
        )
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    fn require_admin(env: &Env, caller: &Address) {
        caller.require_auth();
        let admin: Address = match get(env, &sym("ADMIN")) {
            Some(a) => a,
            None => panic_with_error!(env, AspError::NotAdmin),
        };
        if &admin != caller {
            panic_with_error!(env, AspError::NotAdmin);
        }
    }
}
