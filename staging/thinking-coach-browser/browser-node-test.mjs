import assert from 'node:assert/strict';
import test from 'node:test';
import * as browser from './browser-coach.mjs';
import { sha256Text } from './sha256.mjs';
import { runChecks } from './browser-checks.mjs';
import { fixtures, expected, vectors } from './test-data.mjs';
test('SHA-256 published vectors and Node crypto differential',()=>{
  assert.equal(vectors[0].sha256,'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(vectors[1].sha256,'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(vectors[3].sha256,'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  for(const v of vectors)assert.equal(sha256Text(v.text),v.sha256);
});
test('Browser JSON API shared behavioral oracles in Node',()=>{
  const old=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('STORAGE_FORBIDDEN');}});
  try{assert(runChecks(browser,fixtures,expected).length>=20);}finally{if(old)Object.defineProperty(globalThis,'localStorage',old);else delete globalThis.localStorage;}
});
