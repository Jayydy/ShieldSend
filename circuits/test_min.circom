pragma circom 2.0.0;

template Test(){
  signal input a;
  signal output b;
  b <== a;
}

component main = Test();
