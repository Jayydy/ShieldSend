// transfer.circom
// Transfer circuit for ShieldSend — spends an existing note and creates a new one

pragma circom 2.0.0;

include "./poseidon_adapter.circom";
include "circomlib/circuits/bitify.circom";
include "./merkle.circom";

template Transfer() {
    // Public inputs
    signal input nullifier;
    signal input new_commitment;
    signal input merkle_root;
    signal input asset_id;

    // Private inputs
    signal input secret;
    signal input amount;
    signal input leaf_index;
    signal input merkle_path[20];
    signal input merkle_path_indices[20];
    signal input recipient_pubkey_self; // sender's pubkey
    signal input recipient_pubkey; // recipient's pubkey (for new note)
    signal input new_secret;

    // 1) Reconstruct input commitment
    component p_in = PoseidonHash(4);
    p_in.in[0] <== secret;
    p_in.in[1] <== amount;
    p_in.in[2] <== asset_id;
    p_in.in[3] <== recipient_pubkey_self;
    signal input_commitment;
    input_commitment <== p_in.out;

    // 2) Verify Merkle inclusion of input_commitment
    component proof = MerkleProof(20);
    proof.leaf <== input_commitment;
    for (var i = 0; i < 20; i++) {
        proof.pathElements[i] <== merkle_path[i];
        proof.pathIndices[i] <== merkle_path_indices[i];
    }

    // Assert proof.root == merkle_root
    signal rootDiff;
    rootDiff <== proof.root - merkle_root;
    rootDiff === 0;

    // 3) Verify nullifier: nullifier === Poseidon(secret, leaf_index)
    component p_null = PoseidonHash(2);
    p_null.in[0] <== secret;
    p_null.in[1] <== leaf_index;
    signal computed_nullifier;
    computed_nullifier <== p_null.out;
    computed_nullifier === nullifier;

    // 4) Construct output commitment and assert equality
    component p_out = PoseidonHash(4);
    p_out.in[0] <== new_secret;
    p_out.in[1] <== amount;
    p_out.in[2] <== asset_id;
    p_out.in[3] <== recipient_pubkey;
    signal computed_new_commitment;
    computed_new_commitment <== p_out.out;
    computed_new_commitment === new_commitment;

    // 5) Amount conservation (trivial equality to keep signal constrained)
    signal amount_check;
    amount_check <== amount - amount;
    amount_check === 0;

    // 6) Range check for amount: 0 < amount < 2^53
    component aBits = Num2Bits(53);
    aBits.in <== amount;

    // Non-zero amount: enforce multiplicative inverse exists
    // `amountInv` provided as a private witness input (the multiplicative inverse of amount)
    signal input amountInv;
    amount * amountInv === 1;

    // Optional: bound leaf_index to 20 bits to be safe
    component idxBits = Num2Bits(20);
    idxBits.in <== leaf_index;
}

component main {public [nullifier, new_commitment, merkle_root, asset_id]} = Transfer();

