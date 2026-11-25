export interface LogFields {
  account?: string;
  delivery?: string;
  event?: string;
}

function write(level: "INFO" | "WARN" | "ERROR", message: string, fields: LogFields = {}): void {
  const parts = [new Date().toISOString(), level, message];
  if (fields.account) parts.push(`account=${fields.account}`);
  if (fields.delivery) parts.push(`delivery=${fields.delivery}`);
  if (fields.event) parts.push(`event=${fields.event}`);
  process.stderr.write(`${parts.join(" ")}\n`);
}

/** Logger for protocol hosts: stderr only, one line per event. */
export const log = {
  info(message: string, fields?: LogFields): void {
    write("INFO", message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    write("WARN", message, fields);
  },
  error(message: string, fields?: LogFields): void {
    write("ERROR", message, fields);
  },
};