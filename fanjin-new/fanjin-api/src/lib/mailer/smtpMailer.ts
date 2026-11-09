import net from "node:net";
import tls from "node:tls";
import { getPlatformSecretValue, getPlatformSettingValue } from "@/lib/platformSettings";

export type SmtpConfig = {
  host: string;
  port: number;
  account: string;
  password: string;
  from: string;
  sslEnabled: boolean;
  forceAuthLogin: boolean;
};

export type SendMailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

type SendMailImpl = (input: SendMailInput) => Promise<void>;

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.trunc(n);
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  const raw = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

export async function resolveSmtpConfig(): Promise<SmtpConfig | null> {
  const host = asString(await getPlatformSettingValue("platform.notification.smtpServer"));
  const account = asString(await getPlatformSettingValue("platform.notification.smtpAccount"));
  const password = asString(await getPlatformSecretValue("platform.notification.smtpToken"));
  if (!host || !account || !password) return null;

  const port = asNumber(await getPlatformSettingValue("platform.notification.smtpPort"), 465);
  const fromRaw = asString(await getPlatformSettingValue("platform.notification.smtpFrom"));
  const from = fromRaw || `Fanjin <${account}>`;
  const sslEnabled = asBoolean(await getPlatformSettingValue("platform.notification.smtpSSLEnabled"), true);
  const forceAuthLogin = asBoolean(
    await getPlatformSettingValue("platform.notification.smtpForceAuthLogin"),
    true,
  );

  return {
    host,
    port,
    account,
    password,
    from,
    sslEnabled,
    forceAuthLogin,
  };
}

export async function isMailConfigured(): Promise<boolean> {
  return Boolean(await resolveSmtpConfig());
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function encodeSubject(subject: string): string {
  if (/^[\x20-\x7E]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${b64(subject)}?=`;
}

function buildMimeMessage(input: SendMailInput, from: string): string {
  const headers = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
  ];
  if (input.html) {
    const boundary = `fanjin_${Date.now().toString(16)}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      input.text,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      input.html,
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n");
  }
  return [
    ...headers,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text,
    "",
  ].join("\r\n");
}

async function defaultSmtpSend(input: SendMailInput): Promise<void> {
  const config = await resolveSmtpConfig();
  if (!config) throw new Error("MAIL_NOT_CONFIGURED");
  await sendMailWithConfig(config, input);
}

export async function sendMailWithConfig(config: SmtpConfig, input: SendMailInput): Promise<void> {
  const to = asString(input.to);
  const subject = asString(input.subject);
  const text = String(input.text || "");
  if (!to || !subject || !text) throw new Error("MAIL_INVALID_INPUT");

  const host = config.host;
  const port = config.port;
  const timeoutMs = 10_000;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let step = "connect";
    let buffer = "";
    const logSafe = (line: string) => line;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      if (err) reject(err);
      else resolve();
    };

    const socket = tls.connect(
      {
        host,
        port,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: true,
      },
      () => {
        step = "greeting";
      },
    );
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);

    const writeLine = (line: string) => {
      socket.write(`${line}\r\n`);
    };

    const handleReply = (code: number, line: string) => {
      if (step === "greeting") {
        if (code !== 220) throw new Error(`SMTP greeting failed (${code})`);
        writeLine(`EHLO fanjin-mailer`);
        step = "ehlo";
        return;
      }
      if (step === "ehlo") {
        if (code !== 250) throw new Error(`SMTP EHLO failed (${code})`);
        writeLine("AUTH LOGIN");
        step = "auth-user-prompt";
        return;
      }
      if (step === "auth-user-prompt") {
        if (code !== 334) throw new Error(`SMTP AUTH LOGIN rejected (${code})`);
        writeLine(b64(config.account));
        step = "auth-pass-prompt";
        return;
      }
      if (step === "auth-pass-prompt") {
        if (code !== 334) throw new Error(`SMTP username rejected (${code})`);
        writeLine(b64(config.password));
        step = "auth-done";
        return;
      }
      if (step === "auth-done") {
        if (code !== 235) throw new Error(`SMTP authentication failed (${code})`);
        writeLine(`MAIL FROM:<${config.account}>`);
        step = "mail-from";
        return;
      }
      if (step === "mail-from") {
        if (code !== 250) throw new Error(`SMTP MAIL FROM failed (${code})`);
        writeLine(`RCPT TO:<${to}>`);
        step = "rcpt-to";
        return;
      }
      if (step === "rcpt-to") {
        if (code !== 250 && code !== 251) throw new Error(`SMTP RCPT TO failed (${code})`);
        writeLine("DATA");
        step = "data";
        return;
      }
      if (step === "data") {
        if (code !== 354) throw new Error(`SMTP DATA not accepted (${code})`);
        const mime = buildMimeMessage(
          { to, subject, text, html: input.html },
          config.from,
        );
        // Dot-stuff lines that begin with '.'
        const stuffed = mime
          .split(/\r?\n/)
          .map((line) => (line.startsWith(".") ? `.${line}` : line))
          .join("\r\n");
        socket.write(`${stuffed}\r\n.\r\n`);
        step = "after-data";
        return;
      }
      if (step === "after-data") {
        if (code !== 250) throw new Error(`SMTP message rejected (${code})`);
        writeLine("QUIT");
        step = "quit";
        return;
      }
      if (step === "quit") {
        finish();
        return;
      }
      throw new Error(`SMTP unexpected state ${step}: ${logSafe(line)}`);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || "";
      for (const raw of parts) {
        const line = raw.replace(/\r$/, "");
        if (!line) continue;
        const code = Number(line.slice(0, 3));
        const cont = line[3] === "-";
        if (!Number.isFinite(code)) continue;
        if (cont) continue;
        try {
          handleReply(code, line);
        } catch (err: any) {
          finish(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
    });

    socket.on("timeout", () => finish(new Error(`SMTP timeout at ${step}`)));
    socket.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
    socket.on("end", () => {
      if (!settled && step !== "quit") finish(new Error(`SMTP connection closed at ${step}`));
    });
  });
}

let sendMailImpl: SendMailImpl = defaultSmtpSend;

export function setSendMailImplForTests(impl: SendMailImpl | null): void {
  // Allow Vitest to simulate production NODE_ENV while still injecting a fake mailer.
  const allow =
    process.env.NODE_ENV !== "prod"
    || process.env.VITEST === "true"
    || process.env.FANJIN_ALLOW_TEST_MAILER === "1";
  if (!allow) {
    throw new Error("setSendMailImplForTests is forbidden in production");
  }
  sendMailImpl = impl || defaultSmtpSend;
}

export async function sendMail(input: SendMailInput): Promise<void> {
  return sendMailImpl(input);
}
