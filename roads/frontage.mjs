// Frontage roads (frontage.py): after build.sh has written <work>/frontage/<ST>.json.gz for every state,
//   node frontage.mjs finish <work> <states>   writes <work>/frontage.json: { buildId, builtAt, states: { TX: { bytes, sha256 } } }
// names.mjs's finish, for the frontage folder. publish.mjs (KIND=frontage) uploads them like the road names, under
// frontage/v1/<buildId>/ with the pointer frontage/current.json = { version, path, states }.
import { finish } from './names.mjs';

const [cmd, work, states] = process.argv.slice(2);
if (cmd === 'finish' && Number(states) > 0) finish(work, Number(states), 'frontage');
else { console.error('usage: node frontage.mjs finish <work> <states>'); process.exit(1); }
