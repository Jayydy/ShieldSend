// withdraw.circom
// Withdraw circuit for ShieldSend — proves note ownership and withdrawal destination

pragma circom 2.0.0;

include "./poseidon_adapter.circom";
include "./merkle.circom";
include "circomlib/circuits/bitify.circom";

template Withdraw() {
    // Public inputs
    signal input nullifier;    // Poseidon(secret, leaf_index)
    signal input merkle_root;  // current tree root
    signal input recipient;    // Stellar address as field element (withdraw destination)
    signal input amount;       // amount being withdrawn (public at withdrawal)
    signal input asset_id;     // asset identifier

    // Private inputs
    signal input secret;
    signal input leaf_index;
    signal input merkle_path[20];
    signal input merkle_path_indices[20];
    signal input recipient_pubkey; // must match public `recipient`

    // 1) Reconstruct the commitment: Poseidon(secret, amount, asset_id, recipient_pubkey)
    component p_in = PoseidonHash(4);
    p_in.in[0] <== secret;
    p_in.in[1] <== amount;
    p_in.in[2] <== asset_id;
    p_in.in[3] <== recipient_pubkey;
    signal reconstructed_commitment;
    reconstructed_commitment <== p_in.out;

    // 2) Verify Merkle inclusion of reconstructed_commitment
    component proof = MerkleProof(20);
    proof.leaf <== reconstructed_commitment;
    for (var i = 0; i < 20; i++) {
        proof.pathElements[i] <== merkle_path[i];
        proof.pathIndices[i] <== merkle_path_indices[i];
    }

    // Assert that proof.root == merkle_root
    signal rootDiff;
    rootDiff <== proof.root - merkle_root;
    rootDiff === 0;

    // 3) Verify nullifier: Poseidon(secret, leaf_index)
    component p_null = PoseidonHash(2);
    p_null.in[0] <== secret;
    p_null.in[1] <== leaf_index;
    signal computed_nullifier;
    computed_nullifier <== p_null.out;
    computed_nullifier === nullifier;

    // 4) Verify recipient matches the note's recipient_pubkey
    signal recipientDiff;
    recipientDiff <== recipient - recipient_pubkey;
    recipientDiff === 0;

    // 5) Amount range check: 0 < amount < 2^53
    component aBits = Num2Bits(53);
    aBits.in <== amount;

    // Non-zero amount: require multiplicative inverse as private witness
    signal input amountInv;
    amount * amountInv === 1;

    // Optional: bound leaf_index to 20 bits
    component idxBits = Num2Bits(20);
    idxBits.in <== leaf_index;
}

component main {public [nullifier, merkle_root, recipient, amount, asset_id]} = Withdraw();
