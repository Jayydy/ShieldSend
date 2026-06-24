// poseidon_adapter.circom
// Adapter to expose a PoseidonHash(n) template compatible with existing circuits,
// backed by circomlib's `Poseidon(n)` implementation.

pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";

template PoseidonHash(n) {
    signal input in[n];
    signal output out;

    component p = Poseidon(n);
    for (var i = 0; i < n; i++) {
        p.inputs[i] <== in[i];
    }
    out <== p.out;
}
