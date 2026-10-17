// Several tests move or snapshot hundreds of files; slow CI runners (windows, Node 20) can pass 5 s.
export default { test: { testTimeout: 30_000 } };
