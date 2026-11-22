import {loadMapperTestSource} from './mapper_test_source.mjs';
const {scripts} = await loadMapperTestSource();
console.log(`Compiled ${scripts.length} actual authored scripts (inline and immutable/SRI-verified shared assets)`);
