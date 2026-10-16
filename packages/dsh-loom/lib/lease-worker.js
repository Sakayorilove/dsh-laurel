/** Owned lease lifetime follows parent stdin; flock owns the descriptor. */
const token = process.argv[2];
if (!token || !/^[0-9a-f-]{36}$/.test(token))
    process.exit(74);
process.stdout.write(JSON.stringify({ ready: true, token }) + '\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(75));
process.on('SIGTERM', () => process.exit(0));
export {};
