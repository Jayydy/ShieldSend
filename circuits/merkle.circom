// merkle.circom
// Poseidon Merkle proof verification circuit (Circom 2)
// Reusable templates: MerkleProof, CheckRoot, LeafExists

pragma circom 2.0.0;

include "./poseidon_adapter.circom";

// MerkleProof: computes the root from a leaf and a Merkle path
template MerkleProof(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    // Use arrays so signals/components are declared in the initial scope
    signal currs[levels + 1];
    currs[0] <== leaf;

    signal bitCheck[levels];
    signal left[levels];
    signal right[levels];
    // intermediate multiplication results to keep constraints quadratic
    signal mulA1[levels];
    signal mulA2[levels];
    signal mulB1[levels];
    signal mulB2[levels];
    component p[levels];
    signal h[levels];

    for (var i = 0; i < levels; i++) {
        // enforce pathIndices[i] is boolean (0 or 1)
        bitCheck[i] <== pathIndices[i] * (pathIndices[i] - 1);
        bitCheck[i] === 0;

        // left/right selection using arithmetic to minimize constraints
        mulA1[i] <== currs[i] * (1 - pathIndices[i]);
        mulA2[i] <== pathElements[i] * pathIndices[i];
        left[i] <== mulA1[i] + mulA2[i];

        mulB1[i] <== pathElements[i] * (1 - pathIndices[i]);
        mulB2[i] <== currs[i] * pathIndices[i];
        right[i] <== mulB1[i] + mulB2[i];

        // Poseidon hash of the pair (left, right)
        p[i] = PoseidonHash(2);
        p[i].in[0] <== left[i];
        p[i].in[1] <== right[i];
        h[i] <== p[i].out;

        currs[i+1] <== h[i];
    }

    root <== currs[levels];
}

// CheckRoot: asserts that two roots are equal
template CheckRoot() {
    signal input root;
    signal input expected;
    signal diff;
    diff <== root - expected;
    diff === 0;
}

// LeafExists: convenience template combining MerkleProof + CheckRoot
template LeafExists(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal input root; // expected root

    component proof = MerkleProof(levels);
    proof.leaf <== leaf;
    for (var i = 0; i < levels; i++) {
        proof.pathElements[i] <== pathElements[i];
        proof.pathIndices[i] <== pathIndices[i];
    }

    component chk = CheckRoot();
    chk.root <== proof.root;
    chk.expected <== root;
}

