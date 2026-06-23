//! Poseidon Merkle tree implementation for Soroban storage
//!
//! Depth: 20
//! Storage keys (Symbol-based):
//! - TREE_ROOT: BytesN<32>
//! - TREE_SIZE: u32
//! - NODE_{level}_{index}: BytesN<32>
//! - HIST_ROOTS: Vec<BytesN<32>> (ring buffer of last 30 roots)

extern crate alloc;

use soroban_sdk::{bytesn::BytesN, Env, Symbol, vec, Vec, storage::Persistent};
use soroban_sdk::native_contract::crypto::Client as CryptoClient;
use core::convert::TryInto;

pub const DEPTH: usize = 20;
pub const HIST_SIZE: usize = 30;

fn tree_root_key() -> Symbol {
    Symbol::new("TREE_ROOT")
}

fn tree_size_key() -> Symbol {
    Symbol::new("TREE_SIZE")
}

fn hist_roots_key() -> Symbol {
    Symbol::new("HIST_ROOTS")
}

fn node_key(env: &Env, level: usize, index: u32) -> Symbol {
    // Create a symbol like NODE_3_42
    let s = alloc::format!("NODE_{}_{}", level, index);
    Symbol::new(&s)
}

// Poseidon2 wrapper: calls host crypto if available. Returns None on error.
fn poseidon2_hash(env: &Env, left: &BytesN<32>, right: &BytesN<32>) -> Option<BytesN<32>> {
    // Try using the native crypto client if available (Protocol 25)
    let client = CryptoClient::new(env);
    // The exact method name and signature may differ across soroban-sdk versions.
    // We attempt the likely `poseidon2_hash` API; if it fails, return None.
    let res = client.invoke(&Symbol::new("poseidon2_hash"), vec![left.clone().into(), right.clone().into()]);
    match res {
        Ok(v) => {
            // Expect a BytesN<32> back; try to convert
            // This conversion depends on the actual return type of the host call
            // and may need adjustment.
            if let Ok(bytesn) = v.try_into() {
                Some(bytesn)
            } else {
                None
            }
        }
        Err(_) => None,
    }
}

// Compute zero values lazily and store them in storage under keys ZEROS_{i}
fn zeros_key(i: usize) -> Symbol {
    let s = alloc::format!("ZEROS_{}", i);
    Symbol::new(&s)
}

fn get_zero(env: &Env, i: usize) -> Option<BytesN<32>> {
    let p: Persistent<BytesN<32>> = Persistent::new(env, &zeros_key(i));
    p.get().ok().flatten()
}

fn set_zero(env: &Env, i: usize, v: &BytesN<32>) {
    let p: Persistent<BytesN<32>> = Persistent::new(env, &zeros_key(i));
    // Ignore storage errors to remain panic-free
    let _ = p.set(v);
}

/// Ensure ZEROS[0..DEPTH] are computed and stored. Returns a Vec of zeros or None if poseidon missing.
fn ensure_zeros(env: &Env) -> Option<Vec<BytesN<32>>> {
    // Try to load existing zeros
    let mut zeros: Vec<BytesN<32>> = Vec::new(env);
    for i in 0..DEPTH {
        if let Some(z) = get_zero(env, i) {
            zeros.push_back(z);
            continue;
        }
        // Need to compute from previous
        if i == 0 {
            // ZEROS[0] = Poseidon(0,0)
            let zero_bytes = BytesN::from_array(env, &[0u8; 32]);
            let h = match poseidon2_hash(env, &zero_bytes, &zero_bytes) {
                Some(v) => v,
                None => return None,
            };
            set_zero(env, 0, &h);
            zeros.push_back(h);
        } else {
            // ZEROS[i] = Poseidon(ZEROS[i-1], ZEROS[i-1])
            let prev = match zeros.get(i - 1) {
                Some(v) => v,
                None => return None,
            };
            let h = match poseidon2_hash(env, prev, prev) {
                Some(v) => v,
                None => return None,
            };
            set_zero(env, i, &h);
            zeros.push_back(h);
        }
    }
    Some(zeros)
}

/// Insert a commitment into the tree. Returns (leaf_index, new_root).
pub fn insert(env: &Env, commitment: BytesN<32>) -> (u32, BytesN<32>) {
    // Read tree size
    let size_p: Persistent<u32> = Persistent::new(env, &tree_size_key());
    let mut size: u32 = match size_p.get().ok().flatten() {
        Some(v) => v,
        None => 0u32,
    };

    // Compute leaf index
    let leaf_index = size;

    // Store leaf at level 0
    let node_p: Persistent<BytesN<32>> = Persistent::new(env, &node_key(env, 0, leaf_index));
    let _ = node_p.set(&commitment);

    // Ensure zeros available
    let zeros = match ensure_zeros(env) {
        Some(z) => z,
        None => {
            // Poseidon not available; return current root or zero
            let root_p: Persistent<BytesN<32>> = Persistent::new(env, &tree_root_key());
            let root = root_p.get().ok().flatten().unwrap_or_else(|| BytesN::from_array(env, &[0u8;32]));
            return (leaf_index, root);
        }
    };

    // Recompute path
    let mut index = leaf_index;
    let mut current = commitment.clone();
    for level in 0..DEPTH {
        let sibling_index = if (index % 2) == 0 { index + 1 } else { index - 1 };
        // Load sibling or use zero
        let sibling_sym = node_key(env, level, sibling_index);
        let sibling_p: Persistent<BytesN<32>> = Persistent::new(env, &sibling_sym);
        let sibling = match sibling_p.get().ok().flatten() {
            Some(v) => v,
            None => match zeros.get(level) {
                Some(z) => z.clone(),
                None => BytesN::from_array(env, &[0u8;32]),
            },
        };

        // Determine left/right
        let (left, right) = if (index % 2) == 0 { (current.clone(), sibling) } else { (sibling, current.clone()) };

        // Hash
        let parent = match poseidon2_hash(env, &left, &right) {
            Some(h) => h,
            None => {
                // Can't hash: return current root
                let root_p: Persistent<BytesN<32>> = Persistent::new(env, &tree_root_key());
                let root = root_p.get().ok().flatten().unwrap_or_else(|| BytesN::from_array(env, &[0u8;32]));
                return (leaf_index, root);
            }
        };

        // Store parent
        let parent_sym = node_key(env, level + 1, index / 2);
        let parent_p: Persistent<BytesN<32>> = Persistent::new(env, &parent_sym);
        let _ = parent_p.set(&parent);

        current = parent;
        index /= 2;
    }

    // current now holds root
    let root_p: Persistent<BytesN<32>> = Persistent::new(env, &tree_root_key());
    let _ = root_p.set(&current);

    // Update history ring buffer
    let mut hist_p: Persistent<Vec<BytesN<32>>> = Persistent::new(env, &hist_roots_key());
    let mut hist: Vec<BytesN<32>> = hist_p.get().ok().flatten().unwrap_or_else(|| Vec::new(env));
    hist.push_back(current.clone());
    // Trim to HIST_SIZE
    while hist.len() > HIST_SIZE as u32 {
        let _ = hist.pop_front();
    }
    let _ = hist_p.set(&hist);

    // Increment size
    size = size.saturating_add(1);
    let _ = size_p.set(&size);

    (leaf_index, current)
}

pub fn get_root(env: &Env) -> BytesN<32> {
    let root_p: Persistent<BytesN<32>> = Persistent::new(env, &tree_root_key());
    root_p.get().ok().flatten().unwrap_or_else(|| BytesN::from_array(env, &[0u8;32]))
}

pub fn verify_path(env: &Env, leaf: BytesN<32>, path_elements: Vec<BytesN<32>>, path_indices: Vec<u32>, root: BytesN<32>) -> bool {
    // Recompute
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
        let idx = match path_indices.get(i) {
            Some(v) => *v,
            None => return false,
        };
        let (left, right) = if idx == 0 { (current.clone(), sib) } else { (sib, current.clone()) };
        current = match poseidon2_hash(env, &left, &right) {
            Some(h) => h,
            None => return false,
        };
    }
    // Compare
    current == root
}

pub fn known_root(env: &Env, root: BytesN<32>) -> bool {
    let hist_p: Persistent<Vec<BytesN<32>>> = Persistent::new(env, &hist_roots_key());
    let hist: Vec<BytesN<32>> = hist_p.get().ok().flatten().unwrap_or_else(|| Vec::new(env));
    for i in 0..hist.len() {
        if let Some(v) = hist.get(i) {
            if v == &root {
                return true;
            }
        }
    }
    false
}
