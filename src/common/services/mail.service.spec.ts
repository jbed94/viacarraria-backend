const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn((options: any) => ({
  sendMail: mockSendMail,
}));

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: (options: any) => mockCreateTransport(options),
  },
  createTransport: (options: any) => mockCreateTransport(options),
}));

import {
  MailService,
  renderActivationEmailHtml,
  renderActivationEmailText,
} from './mail.service.js';

describe('MailService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Self-Contained Console / Memory Mode', () => {
    it('operates in console/memory mode when SMTP_HOST is not configured', async () => {
      const service = new MailService();

      const result = await service.sendVerificationEmail({
        to: 'newuser@example.com',
        name: 'Ada Lovelace',
        url: 'http://localhost:3000/api/auth/verify-email?token=token-123',
        token: 'token-123',
      });

      expect(result).toEqual({ success: true, mode: 'console' });
      expect(mockCreateTransport).not.toHaveBeenCalled();

      const lastEmail = service.getLastSentEmail();
      expect(lastEmail).toBeDefined();
      expect(lastEmail?.to).toBe('newuser@example.com');
      expect(lastEmail?.subject).toBe('Activate your Via Carraria account');
      expect(lastEmail?.token).toBe('token-123');
      expect(lastEmail?.url).toBe(
        'http://localhost:3000/api/auth/verify-email?token=token-123',
      );
      expect(lastEmail?.text).toContain('Ada Lovelace');
      expect(lastEmail?.text).toContain(
        'http://localhost:3000/api/auth/verify-email?token=token-123',
      );
      expect(lastEmail?.html).toContain('Ada Lovelace');
      expect(lastEmail?.mode).toBe('console');
    });

    it('retains up to 50 sent email records and clears them on request', async () => {
      const service = new MailService();
      service.clearSentEmails();

      for (let i = 0; i < 5; i++) {
        await service.sendVerificationEmail({
          to: `user${i}@example.com`,
          url: `http://localhost:3000/verify?t=${i}`,
          token: `token-${i}`,
        });
      }

      expect(service.getSentEmails()).toHaveLength(5);
      expect(service.getLastSentEmail()?.to).toBe('user4@example.com');

      service.clearSentEmails();
      expect(service.getSentEmails()).toHaveLength(0);
      expect(service.getLastSentEmail()).toBeUndefined();
    });
  });

  describe('SMTP Transport Mode', () => {
    it('sends email via nodemailer when SMTP_HOST is configured', async () => {
      process.env.SMTP_HOST = 'smtp.example.com';
      process.env.SMTP_PORT = '587';
      process.env.SMTP_USER = 'smtp-user';
      process.env.SMTP_PASS = 'smtp-pass';

      mockSendMail.mockResolvedValueOnce({ messageId: 'msg-1' });

      const service = new MailService();
      expect(mockCreateTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: 'smtp.example.com',
          port: 587,
          auth: {
            user: 'smtp-user',
            pass: 'smtp-pass',
          },
        }),
      );

      const result = await service.sendVerificationEmail({
        to: 'alanking@example.com',
        name: 'Alan Turing',
        url: 'http://localhost:3000/api/auth/verify-email?token=turing-token',
        token: 'turing-token',
      });

      expect(result).toEqual({ success: true, mode: 'smtp' });
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'alanking@example.com',
          subject: 'Activate your Via Carraria account',
        }),
      );
      expect(service.getLastSentEmail()?.mode).toBe('smtp');
    });

    it('falls back to console dispatch if SMTP transmission throws', async () => {
      process.env.SMTP_HOST = 'smtp.failing.org';

      mockSendMail.mockRejectedValueOnce(new Error('Connection timed out'));

      const service = new MailService();

      const result = await service.sendVerificationEmail({
        to: 'grace@navy.mil',
        name: 'Grace Hopper',
        url: 'http://localhost:3000/verify?token=hopper',
        token: 'hopper',
      });

      expect(result).toEqual({ success: true, mode: 'console' });
      expect(service.getLastSentEmail()?.to).toBe('grace@navy.mil');
      expect(service.getLastSentEmail()?.mode).toBe('console');
    });
  });

  describe('Branded Activation Email Templates', () => {
    it('renders branded HTML with Via Carraria mint/coral identity, button CTA, and token box', () => {
      const html = renderActivationEmailHtml({
        name: 'Marie Curie',
        url: 'https://viacarraria.com/activate?token=radium-42',
        token: 'radium-42',
      });

      expect(html).toContain('Marie Curie');
      expect(html).toContain('Via</span> Carraria');
      expect(html).toContain('#2c7950'); // Mint
      expect(html).toContain('#bd503a'); // Coral
      expect(html).toContain(
        'https://viacarraria.com/activate?token=radium-42',
      );
      expect(html).toContain('radium-42');
      expect(html).toContain('24 hours');
      expect(html).toContain('Activate My Account');
    });

    it('renders plain text template with fallback recipient name', () => {
      const text = renderActivationEmailText({
        url: 'https://viacarraria.com/activate?token=abc',
        token: 'abc',
      });

      expect(text).toContain('Hello Knowledge Explorer,');
      expect(text).toContain('https://viacarraria.com/activate?token=abc');
      expect(text).toContain('Activation token: abc');
      expect(text).toContain('24 hours');
    });
  });
});
