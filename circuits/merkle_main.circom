// merkle_main.circom
// Simple wrapper to compile MerkleProof as a standalone circuit (for testing).

pragma circom 2.0.0;

include "./merkle.circom";

// Expose inputs and root as public for standalone compilation
component main {public [leaf, pathElements, pathIndices]} = MerkleProof(20);
