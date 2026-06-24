// deposit.circom
// Deposit circuit for ShieldSend — verifies commitment correctness

pragma circom 2.0.0;

include "./poseidon_adapter.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

template Deposit() {
    // Public inputs (made public at top-level instantiation)
    signal input commitment;
    signal input amount;
    signal input asset_id;

    // Private inputs
    signal input secret;
    signal input recipient_pubkey;

    // Range check: amount < 2^53 using Num2Bits(53)
    component aBits = Num2Bits(53);
    aBits.in <== amount;

    // Num2Bits enforces 0 <= amount < 2^53 and provides aBits.out[] bits

    // Non-zero check: require existence of multiplicative inverse
    // If amount == 0 no inverse exists and the circuit is unsatisfiable
    // `amountInv` provided as a private witness input (the multiplicative inverse of amount)
    signal input amountInv;
    amount * amountInv === 1;

    // Compute expected commitment: Poseidon(secret, amount, asset_id, recipient_pubkey)
    component p = PoseidonHash(4);
    p.in[0] <== secret;
    p.in[1] <== amount;
    p.in[2] <== asset_id;
    p.in[3] <== recipient_pubkey;
    signal expected;
    expected <== p.out;

    // Assert equality with provided public commitment
    commitment === expected;
}

component main {public [commitment, amount, asset_id]} = Deposit();
