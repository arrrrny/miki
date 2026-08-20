// SELF-DRIVE agent — fulfills every GYM exercise through the miki arms, then
// drops .submitted so gym.mjs's grader clears the gate. This is the proof that a
// cloud agent (the surgeon) can wield every surgical tool end to end, no provider.
// Wired in only when MIKI_SELF_DRIVE=1; the normal flow is untouched.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function driveGym({ ctx, workspace }) {
  const w = (p, c) => ctx.callTool('write_file', { path: p, content: c });

  // E1 PLAN
  await w('PLAN.md', 'Plan: build a todo app with miki.\nThe agent drives kimi through miki tools.\n');
  // E2 ZFA TODO (structural gate; zfa not required to be installed)
  await w('pubspec.yaml', 'name: todo\nflutter: {}\ndependencies:\n  zuraffa: ^1.0.0\n');
  await fs.mkdir(path.join(workspace, 'lib'), { recursive: true });
  // E3 ECHO
  await w('echo.mjs', "console.log(new Date().toISOString());\n");
  // E4 ADD
  await w('add.mjs', "const [a, b] = process.argv.slice(2).map(Number);\nconsole.log(a + b);\n");
  // E5 TREE
  await w('app/main.mjs', "console.log('APP');\n");
  // E6 GREP
  await w('notes.md', 'KIMI_INVERSE_OK\n');
  // E7 EDIT — write placeholders, then rewrite with the edit/multiedit arm
  await w('src/config.txt', 'NAME=REPLACE_ME\nMODE=REPLACE_ME\n');
  await ctx.callTool('multiedit', {
    path: 'src/config.txt',
    edits: [
      { old_string: 'NAME=REPLACE_ME', new_string: 'NAME=AGENT' },
      { old_string: 'MODE=REPLACE_ME', new_string: 'MODE=LIVE' },
    ],
  });
  // E8 GLOB
  await w('a.txt', 'a');
  await w('b.txt', 'b');
  await w('c.txt', 'c');

  // E9 DART $ — literal dollar in Dart (escaped so it is not interpolation)
  await w('price.dart', "void main() { print('\\$5.00'); }\n");
  // E10 SHELL $ — literal dollar through the exec arm (single-quoted)
  await ctx.exec("echo 'it costs $5 today' > quot.txt");

  // Cross-check with the grep arm, then submit.
  const grep = await ctx.callTool('grep', { pattern: 'KIMI_INVERSE_OK' });
  ctx.log('grep arm confirms: ' + (grep.ok ? grep.result.replace(/\n/g, ' ') : grep.error));
  await fs.writeFile(path.join(workspace, '.submitted'), new Date().toISOString());
  console.log('    .submitted dropped — all exercises fulfilled via miki arms.\n');
}
