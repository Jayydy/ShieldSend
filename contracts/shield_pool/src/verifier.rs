//! Groth16 verifier helpers for Shield Pool (Soroban)
//!
//! This module provides a panic-free verifier for Groth16 proofs using the
//! BN254 host functions exposed by Stellar Protocol 25. Host calls are
//! represented with small wrappers that currently contain placeholders; replace
//! those placeholders with the real Soroban host invocations when wiring to
//! the runtime.

use soroban_sdk::{Env, vec::Vec, Symbol};
use core::convert::TryInto;
use soroban_sdk::native_contract::crypto::Client as CryptoClient;

// U256 representation (big-endian bytes). Use 32-byte arrays for field/scalar
pub type U256 = [u8; 32];
pub type G1Point = (U256, U256);
pub type G2Point = (U256, U256, U256, U256);

#[derive(Clone)]
pub struct VerifyingKey {
    pub alpha: G1Point,
    pub beta: G2Point,
    pub gamma: G2Point,
    pub delta: G2Point,
    pub ic: Vec<G1Point>, // ic[0] + sum(input_i * ic[i+1])
}

#[derive(Clone)]
pub struct Proof {
    pub a: G1Point,
    pub b: G2Point,
    pub c: G1Point,
}

// --- Host-call wrappers (placeholders) ---
// Each returns Option to avoid panics; None indicates a host error or malformed input.

fn g1_add(env: &Env, p: &G1Point, q: &G1Point) -> Option<G1Point> {
    let client = CryptoClient::new(env);
    // Try invoking bn254_add host function
    let args = vec![p.clone().into(), q.clone().into()];
    if let Ok(v) = client.invoke(&Symbol::new("bn254_add"), args) {
        if let Ok(pt) = v.try_into() {
            return Some(pt);
        }
    }
    None
}

fn g1_scalar_mul(env: &Env, p: &G1Point, s: &U256) -> Option<G1Point> {
    let client = CryptoClient::new(env);
    let args = vec![p.clone().into(), s.clone().into()];
    if let Ok(v) = client.invoke(&Symbol::new("bn254_scalar_mul"), args) {
        if let Ok(pt) = v.try_into() {
            return Some(pt);
        }
    }
    None
}

fn pairing(env: &Env, p: &G1Point, q: &G2Point) -> Option<Vec<u8>> {
    let client = CryptoClient::new(env);
    let args = vec![p.clone().into(), q.clone().into()];
    if let Ok(v) = client.invoke(&Symbol::new("bn254_pairing"), args) {
        // Expect bytes representing pairing element
        if let Ok(b) = v.try_into() {
            return Some(b);
        }
    }
    None
}

fn pairing_mul(_env: &Env, a: &Vec<u8>, b: &Vec<u8>) -> Option<Vec<u8>> {
    // If the host has a pairing product operation, call it here. Otherwise
    // return None to indicate not available.
    // Placeholder: `bn254_pairing_mul`
    let _ = (_env, a, b);
    None
}

fn pairing_eq(_env: &Env, a: &Vec<u8>, b: &Vec<u8>) -> Option<bool> {
    Some(a == b)
}

// Compute vk_x = ic[0] + sum(public_inputs[i] * ic[i+1])
fn compute_vk_x(env: &Env, vk: &VerifyingKey, public_inputs: &[U256]) -> Option<G1Point> {
    let ic_len = vk.ic.len();
    if ic_len == 0 {
        return None;
    }
    // Expect public_inputs.len() == ic_len - 1
    if public_inputs.len() != ic_len.saturating_sub(1) {
        return None;
    }

    // Start with ic[0]
    let mut acc = vk.ic.get(0).cloned().unwrap_or_else(|| ([0u8;32], [0u8;32]));

    for (i, inp) in public_inputs.iter().enumerate() {
        let ic_point = match vk.ic.get(i + 1) {
            Some(p) => p,
            None => return None,
        };
        // scalar multiply ic_point by inp
        let mul = match g1_scalar_mul(env, ic_point, inp) {
            Some(p) => p,
            None => return None,
        };
        // add to accumulator
        acc = match g1_add(env, &acc, &mul) {
            Some(p) => p,
            None => return None,
        };
    }

    Some(acc)
}

/// Verify a Groth16 proof in a panic-free way. Returns `true` on valid proof,
/// `false` on invalid proof or any error.
pub fn verify(env: &Env, vk: &VerifyingKey, proof: &Proof, public_inputs: &[U256]) -> bool {
    // Basic input sanity
    if vk.ic.len() == 0 {
        return false;
    }
    if public_inputs.len() != vk.ic.len().saturating_sub(1) {
        return false;
    }

    // Compute vk_x
    let vk_x = match compute_vk_x(env, vk, public_inputs) {
        Some(p) => p,
        None => return false,
    };

    // Compute pairings: e(A,B), e(alpha,beta), e(vk_x,gamma), e(C,delta)
    let p_ab = match pairing(env, &proof.a, &proof.b) { Some(v) => v, None => return false };
    let p_ab_alpha = match pairing(env, &vk.alpha, &vk.beta) { Some(v) => v, None => return false };
    let p_vkx_g = match pairing(env, &vk_x, &vk.gamma) { Some(v) => v, None => return false };
    let p_c_d = match pairing(env, &proof.c, &vk.delta) { Some(v) => v, None => return false };

    // Multiply the pairings on the right-hand side: p_ab_alpha * p_vkx_g * p_c_d
    let rhs1 = match pairing_mul(env, &p_ab_alpha, &p_vkx_g) { Some(v) => v, None => return false };
    let rhs = match pairing_mul(env, &rhs1, &p_c_d) { Some(v) => v, None => return false };

    // Compare
    match pairing_eq(env, &p_ab, &rhs) {
        Some(eq) => eq,
        None => false,
    }
}

// Convenience verifiers that arrange public inputs in the order expected by each circuit
pub fn verify_deposit_proof(env: &Env, vk: &VerifyingKey, proof: &Proof, commitment: U256, amount: U256, asset_id: U256) -> bool {
    let pubs: [U256; 3] = [commitment, amount, asset_id];
    verify(env, vk, proof, &pubs)
}

pub fn verify_transfer_proof(env: &Env, vk: &VerifyingKey, proof: &Proof, nullifier: U256, new_commitment: U256, merkle_root: U256, asset_id: U256) -> bool {
    let pubs: [U256; 4] = [nullifier, new_commitment, merkle_root, asset_id];
    verify(env, vk, proof, &pubs)
}

pub fn verify_withdraw_proof(env: &Env, vk: &VerifyingKey, proof: &Proof, nullifier: U256, merkle_root: U256, recipient: U256, amount: U256, asset_id: U256) -> bool {
    let pubs: [U256; 5] = [nullifier, merkle_root, recipient, amount, asset_id];
    verify(env, vk, proof, &pubs)
}
