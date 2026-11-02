import {executeQuery} from '../../../business-tools/ocean-freight/engine.mjs'
import snapshot from '../../../business-tools/ocean-freight/data/catalog.json?raw'
// The snapshot is public reference data. Keep it in the lazy feature chunk;
// importing as text avoids inferring 13,000 port literals in TypeScript.
const catalog=JSON.parse(snapshot)
export const queryOcean=(input:Record<string,unknown>)=>executeQuery(input,catalog)
