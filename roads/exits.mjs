// Freeway exits (exits.py): after build.sh has written <work>/exits/<ST>.json.gz for every state,
//   node exits.mjs finish <work> <states>   writes <work>/exits.json: { buildId, builtAt, states: { TX: { bytes, sha256 } } }
// names.mjs's finish, for the exits folder. publish.mjs (KIND=exits) uploads them like the road names, under
// exits/v1/<buildId>/ with the pointer exits/current.json = { version, path, states }.
import { finish } from './names.mjs';

const [cmd, work, states] = process.argv.slice(2);
if (cmd === 'finish' && Number(states) > 0) finish(work, Number(states), 'exits');
else { console.error('usage: node exits.mjs finish <work> <states>'); process.exit(1); }
