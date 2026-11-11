// Admin commands. None of them ever print who is giving to whom.
//
//   npm run load participants.json   add/update participants from a JSON file
//   npm run draw                     randomly assign recipients (refuses if already drawn)
//   npm run draw -- --force          redo the draw from scratch
//   npm run status                   list participants and whether the draw is done
//   npm run reveal                   let everyone see who they're shopping for
//   npm run hide                     hide recipients again (placeholder shown instead)
const fs = require('node:fs');
const crypto = require('node:crypto');
const { db, init, one, all, getSetting, setSetting, normalizePhone } = require('./db');

const [cmd, arg] = process.argv.slice(2);

async function load(file) {
  if (!file) throw new Error('Usage: npm run load participants.json');
  const people = JSON.parse(fs.readFileSync(file, 'utf8'));
  const statements = people.map((p) => {
    const phone = normalizePhone(p.phone);
    if (!p.name || phone.length < 7) throw new Error(`Bad entry: ${JSON.stringify(p)}`);
    return {
      sql: `INSERT INTO participants (name, phone) VALUES (?, ?)
            ON CONFLICT(phone) DO UPDATE SET name = excluded.name`,
      args: [p.name.trim(), phone],
    };
  });
  await db.batch(statements, 'write');
  console.log(`Loaded ${people.length} participants.`);
}

async function draw(force) {
  const ids = (await all('SELECT id FROM participants')).map((r) => Number(r.id));
  if (ids.length < 3) throw new Error('Need at least 3 participants.');

  const { n } = await one('SELECT COUNT(*) AS n FROM participants WHERE recipient_id IS NOT NULL');
  if (Number(n) && !force) {
    throw new Error('Draw already done. Use "npm run draw -- --force" to redo it (everyone gets a new recipient).');
  }

  // Shuffle with a secure random source, then have each person give to the next one
  // in the shuffled order (last gives to first). This forms one big loop, so nobody
  // ever draws themselves and there are no small closed pairs.
  for (let i = ids.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }

  // batch() runs everything in one transaction: all assignments save, or none do.
  await db.batch([
    'UPDATE participants SET recipient_id = NULL',
    ...ids.map((giver, i) => ({
      sql: 'UPDATE participants SET recipient_id = ? WHERE id = ?',
      args: [ids[(i + 1) % ids.length], giver],
    })),
  ], 'write');
  console.log(`Draw complete for ${ids.length} participants. Results are secret — only each person can see their own recipient.`);
}

async function status() {
  const rows = await all('SELECT name, phone, recipient_id IS NOT NULL AS drawn FROM participants ORDER BY name');
  for (const r of rows) console.log(`${r.drawn ? '✓' : '·'} ${r.name} (${r.phone})`);
  console.log(rows.length ? `\n${rows.filter((r) => r.drawn).length}/${rows.length} have a recipient.` : 'No participants yet.');
  console.log(`Recipients are ${(await getSetting('revealed')) === '1' ? 'VISIBLE to everyone' : 'hidden'}.`);
}

async function setRevealed(on) {
  await setSetting('revealed', on ? '1' : '0');
  console.log(on ? 'Revealed! Everyone can now see who they are shopping for.' : 'Recipients are hidden. Everyone sees the "coming soon" message.');
}

(async () => {
  await init();
  if (cmd === 'load') await load(arg);
  else if (cmd === 'draw') await draw(arg === '--force');
  else if (cmd === 'status') await status();
  else if (cmd === 'reveal') await setRevealed(true);
  else if (cmd === 'hide') await setRevealed(false);
  else console.log('Commands: load <file.json> | draw [--force] | status | reveal | hide');
})().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
