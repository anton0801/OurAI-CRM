/**
 * Transactional e-mail templates. Bodies never contain financial amounts, OFM contact aliases
 * or restricted content; they link back into the application where access is re-checked.
 */
export interface MailTemplateInput {
  appOrigin: string;
  workspaceName?: string;
  recipientName?: string;
  [key: string]: unknown;
}

export interface RenderedMail {
  subject: string;
  text: string;
}

const footer = (origin: string) => `\n\n—\nCastlane CRM · ${origin}\nThis message was sent automatically. Do not reply.`;

export const MAIL_TEMPLATES = {
  invitation: (i: MailTemplateInput & { inviteUrl: string; inviterName: string; expiresAt: string }): RenderedMail => ({
    subject: `You are invited to ${i.workspaceName ?? 'a Castlane workspace'}`,
    text: `${i.inviterName} invited you to join ${i.workspaceName ?? 'a workspace'} in Castlane CRM.\n\nAccept the invitation: ${i.inviteUrl}\n\nThe link expires at ${i.expiresAt} and can be used once.${footer(i.appOrigin)}`,
  }),
  passwordReset: (i: MailTemplateInput & { resetUrl: string }): RenderedMail => ({
    subject: 'Reset your Castlane password',
    text: `A password reset was requested for your account.\n\nReset your password: ${i.resetUrl}\n\nThe link expires in 30 minutes and can be used once. If you did not request this, you can ignore this message.${footer(i.appOrigin)}`,
  }),
  securityAlert: (i: MailTemplateInput & { event: string; when: string }): RenderedMail => ({
    subject: 'Security alert for your Castlane account',
    text: `Security event: ${i.event}\nTime: ${i.when}\n\nIf this was not you, sign in and review your active sessions, or contact your workspace administrator.${footer(i.appOrigin)}`,
  }),
  emailChange: (i: MailTemplateInput & { confirmUrl: string }): RenderedMail => ({
    subject: 'Confirm your new e-mail address',
    text: `Confirm this address for your Castlane account: ${i.confirmUrl}\n\nThe link expires in 60 minutes.${footer(i.appOrigin)}`,
  }),
  digest: (i: MailTemplateInput & { count: number; inboxUrl: string }): RenderedMail => ({
    subject: `You have ${i.count} new notification${i.count === 1 ? '' : 's'} in Castlane`,
    text: `You have ${i.count} unread notification${i.count === 1 ? '' : 's'}.\n\nOpen your inbox: ${i.inboxUrl}${footer(i.appOrigin)}`,
  }),
  notification: (i: MailTemplateInput & { title: string; url: string }): RenderedMail => ({
    subject: i.title,
    text: `${i.title}\n\nOpen in Castlane: ${i.url}${footer(i.appOrigin)}`,
  }),
  reportReady: (i: MailTemplateInput & { reportName: string; url: string }): RenderedMail => ({
    subject: 'A scheduled report is ready',
    text: `Your scheduled report "${i.reportName}" is ready in your Castlane inbox.\n\nOpen: ${i.url}${footer(i.appOrigin)}`,
  }),
  testMessage: (i: MailTemplateInput): RenderedMail => ({
    subject: 'Castlane mail configuration test',
    text: `This is a test message sent to yourself from Workspace Settings. Mail delivery is working.${footer(i.appOrigin)}`,
  }),
} as const;

export type MailTemplateKey = keyof typeof MAIL_TEMPLATES;
