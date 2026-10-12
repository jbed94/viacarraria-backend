import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export type SentEmailRecord = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  token?: string;
  url?: string;
  sentAt: Date;
  mode: 'smtp' | 'console';
};

export type SendVerificationEmailOptions = {
  to: string;
  name?: string;
  url: string;
  token: string;
};

export type SendEmailOptions = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  token?: string;
  url?: string;
};

export function renderActivationEmailText(options: {
  name?: string;
  url: string;
  token: string;
}): string {
  const recipientName = options.name?.trim() || 'Knowledge Explorer';
  return [
    `Hello ${recipientName},`,
    '',
    'Thank you for registering on Via Carraria!',
    'Please activate your account by opening the following link in your browser:',
    options.url,
    '',
    `Activation token: ${options.token}`,
    '',
    'This link will expire in 24 hours. If you did not create this account, please ignore this email.',
    '',
    '— The Via Carraria Team',
  ].join('\n');
}

export function renderActivationEmailHtml(options: {
  name?: string;
  url: string;
  token: string;
}): string {
  const recipientName = options.name?.trim() || 'Knowledge Explorer';
  const currentYear = new Date().getFullYear();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Activate your Via Carraria account</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f8fafc; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 580px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.05);">
          <!-- Brand Header Banner -->
          <tr>
            <td style="background-color: #0f172a; padding: 28px 32px; text-align: left; border-bottom: 3px solid #2c7950;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <span style="font-size: 20px; font-weight: 700; color: #ffffff; letter-spacing: -0.5px; display: inline-block;">
                      <span style="color: #2c7950;">Via</span> Carraria
                    </span>
                    <span style="display: block; font-size: 12px; color: #94a3b8; margin-top: 4px; letter-spacing: 0.2px;">
                      Interactive Knowledge Canvas &amp; Spatial GraphRAG
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; width: 12px; height: 12px; border-radius: 50%; background-color: #bd503a;" title="Connected Node"></span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding: 36px 32px 28px 32px;">
              <h1 style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: #0f172a; letter-spacing: -0.3px;">
                Activate Your Account
              </h1>
              <p style="margin: 0 0 16px 0; font-size: 15px; line-height: 1.6; color: #334155;">
                Hello <strong>${recipientName}</strong>,
              </p>
              <p style="margin: 0 0 24px 0; font-size: 15px; line-height: 1.6; color: #334155;">
                Thank you for joining Via Carraria! You are one step away from exploring interactive knowledge graphs and Spatial GraphRAG. Please activate your account to get started:
              </p>
              <!-- Primary CTA Button -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0 32px 0;">
                <tr>
                  <td align="center">
                    <a href="${options.url}" target="_blank" style="background-color: #2c7950; color: #ffffff; font-size: 15px; font-weight: 600; text-decoration: none; padding: 14px 32px; border-radius: 8px; display: inline-block; box-shadow: 0 2px 4px rgba(44, 121, 80, 0.25);">
                      Activate My Account &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <!-- Security / Token Box -->
              <div style="background-color: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 0 0 24px 0;">
                <p style="margin: 0 0 6px 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b;">
                  Activation Token
                </p>
                <code style="font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace; font-size: 14px; color: #0f172a; word-break: break-all;">
                  ${options.token}
                </code>
              </div>
              <p style="margin: 0 0 8px 0; font-size: 13px; line-height: 1.5; color: #64748b;">
                Having trouble clicking the button? Copy and paste the link below into your browser:
              </p>
              <p style="margin: 0 0 24px 0; font-size: 12px; line-height: 1.5; word-break: break-all;">
                <a href="${options.url}" style="color: #2c7950; text-decoration: underline;">${options.url}</a>
              </p>
              <!-- Expiry Alert -->
              <p style="margin: 0; font-size: 12px; color: #94a3b8; line-height: 1.4; border-top: 1px solid #f1f5f9; padding-top: 16px;">
                This link will expire in <strong>24 hours</strong>. If you did not register for an account, please disregard this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 32px; text-align: center;">
              <p style="margin: 0; font-size: 12px; color: #94a3b8; line-height: 1.5;">
                &copy; ${currentYear} Via Carraria. Self-hosted &amp; Open Knowledge Platform.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;
  private readonly sentEmails: SentEmailRecord[] = [];

  constructor() {
    this.initTransporter();
  }

  private initTransporter(): void {
    const host = process.env.SMTP_HOST;
    if (host) {
      const port = Number.parseInt(process.env.SMTP_PORT ?? '587', 10);
      const secure = process.env.SMTP_SECURE === 'true' || port === 465;
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;

      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user ? { user, pass } : undefined,
      });

      this.logger.log(
        `Configured SMTP transport for ${host}:${port} (secure: ${secure})`,
      );
    } else {
      this.transporter = null;
      this.logger.log(
        'No SMTP_HOST specified. MailService operating in self-contained console/memory mode.',
      );
    }
  }

  get fromAddress(): string {
    return (
      process.env.SMTP_FROM ||
      process.env.EMAIL_FROM ||
      'Via Carraria <no-reply@viacarraria.local>'
    );
  }

  async sendVerificationEmail(
    options: SendVerificationEmailOptions,
  ): Promise<{ success: boolean; mode: 'smtp' | 'console' }> {
    const { to, name, url, token } = options;
    const subject = 'Activate your Via Carraria account';

    const text = renderActivationEmailText({ name, url, token });
    const html = renderActivationEmailHtml({ name, url, token });

    return this.sendEmail({
      to,
      subject,
      text,
      html,
      token,
      url,
    });
  }

  async sendEmail(
    options: SendEmailOptions,
  ): Promise<{ success: boolean; mode: 'smtp' | 'console' }> {
    const { to, subject, text, html, token, url } = options;

    if (this.transporter) {
      try {
        await this.transporter.sendMail({
          from: this.fromAddress,
          to,
          subject,
          text,
          html,
        });

        this.recordEmail({
          to,
          subject,
          text,
          html,
          token,
          url,
          sentAt: new Date(),
          mode: 'smtp',
        });

        return { success: true, mode: 'smtp' };
      } catch (error) {
        this.logger.error(`Failed to send email via SMTP to ${to}: ${error}`);
        // Fall back to recording and logging locally so flow is never completely blocked
        this.logToConsole(to, subject, text, url, token);
        this.recordEmail({
          to,
          subject,
          text,
          html,
          token,
          url,
          sentAt: new Date(),
          mode: 'console',
        });
        return { success: true, mode: 'console' };
      }
    }

    // Self-contained console / memory mode
    this.logToConsole(to, subject, text, url, token);
    this.recordEmail({
      to,
      subject,
      text,
      html,
      token,
      url,
      sentAt: new Date(),
      mode: 'console',
    });

    return { success: true, mode: 'console' };
  }

  private logToConsole(
    to: string,
    subject: string,
    text: string,
    url?: string,
    token?: string,
  ): void {
    this.logger.log(
      `\n════════════════════════════════════════════════════════════\n` +
        `[MAIL DISPATCH: ${subject}]\n` +
        `To: ${to}\n` +
        (url ? `Activation URL: ${url}\n` : '') +
        (token ? `Token: ${token}\n` : '') +
        `------------------------------------------------------------\n` +
        `${text}\n` +
        `════════════════════════════════════════════════════════════`,
    );
  }

  private recordEmail(record: SentEmailRecord): void {
    this.sentEmails.push(record);
    if (this.sentEmails.length > 50) {
      this.sentEmails.shift();
    }
  }

  getLastSentEmail(): SentEmailRecord | undefined {
    return this.sentEmails[this.sentEmails.length - 1];
  }

  getSentEmails(): SentEmailRecord[] {
    return [...this.sentEmails];
  }

  clearSentEmails(): void {
    this.sentEmails.length = 0;
  }
}

export const sharedMailService = new MailService();
