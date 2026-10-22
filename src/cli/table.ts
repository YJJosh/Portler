import type { Assignments, PortTransport } from '../types/index.ts';

/** Render a generic padded table with a header row and dashed separator. */
export function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
      .join('  ')
      .trimEnd();

  process.stdout.write(`${line(headers)}\n`);
  process.stdout.write(`${line(widths.map((width) => '-'.repeat(width)))}\n`);
  for (const row of rows) process.stdout.write(`${line(row)}\n`);
}

// REVIEW: the URL column says http:// for a UDP port too (protocol is the URL
// scheme), so without this a UDP-only game server reads as a plain TCP port.
// TCP rows are unchanged.
/** A port as the tables show it: `19132/udp` or `7777/tcp+udp`, plain for TCP. */
export function portLabel(port: number, transport: PortTransport | undefined): string {
  return transport === undefined || transport === 'tcp' ? String(port) : `${port}/${transport}`;
}

/** Render the SERVICE / PORT / URL table for `up`, `ports`, and friends. */
export function printPortTable(assignments: Assignments, serviceNames?: string[]): void {
  const names = serviceNames?.length ? serviceNames : Object.keys(assignments);
  const rows = names
    .filter((name) => assignments[name])
    .map((name) => {
      const assignment = assignments[name]!;
      return [name, portLabel(assignment.port, assignment.transport), assignment.url];
    });

  if (rows.length === 0) {
    process.stdout.write('[portler] no assigned ports\n');
    return;
  }

  printTable(['SERVICE', 'PORT', 'URL'], rows);
}
