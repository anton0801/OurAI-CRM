import nodemailer from 'nodemailer';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  readonly transport: 'smtp' | 'dev_sink';
  send(mail: OutgoingMail): Promise<{ messageId: string | null }>;
  verify(): Promise<{ ok: boolean; detail?: string }>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username?: string;
  password?: string;
  from: string;
}

export class SmtpMailer implements Mailer {
  readonly transport = 'smtp' as const;
  private readonly t: ReturnType<typeof nodemailer.createTransport>;
  constructor(private readonly cfg: SmtpConfig) {
    this.t = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
    });
  }
  async send(mail: OutgoingMail) {
    const info = await this.t.sendMail({ from: this.cfg.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    return { messageId: info.messageId ?? null };
  }
  async verify() {
    try {
      await this.t.verify();
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }
}

/**
 * Local development sink: messages stay in the `mail_messages` table (transport = dev_sink) and
 * are readable at /dev/mailbox in non-production builds. Nothing leaves the machine.
 */
export class DevSinkMailer implements Mailer {
  readonly transport = 'dev_sink' as const;
  async send() {
    return { messageId: null };
  }
  async verify() {
    return { ok: true, detail: 'Local development mailbox (messages are not delivered).' };
  }
}

export * from './templates';
