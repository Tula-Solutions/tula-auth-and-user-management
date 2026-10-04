import { describe, expect, test } from 'bun:test'
import { createTransport } from 'nodemailer'
import { SmtpMailer, type SmtpTransport } from '~/adapters/mail/smtp'

const message = {
  to: 'maya@northline.app',
  subject: '123456 is your verification code',
  text: 'Enter this code: 123456',
  html: '<p>123456</p>',
}

describe('SmtpMailer', () => {
  test('sends the message from the configured sender', async () => {
    const sent: unknown[] = []
    const transport: SmtpTransport = {
      sendMail: async (mail) => {
        sent.push(mail)
      },
      verify: async () => true,
      close: () => {},
    }
    const mailer = new SmtpMailer({
      url: 'smtp://127.0.0.1:1025',
      from: 'Tula <no-reply@auth.test>',
      transport,
    })
    await mailer.send(message)
    expect(sent).toEqual([{ from: 'Tula <no-reply@auth.test>', ...message }])
  })

  test('produces a well-formed message through nodemailer', async () => {
    // jsonTransport builds the real MIME envelope without opening a socket.
    const json = createTransport({ jsonTransport: true })
    let built = ''
    const transport: SmtpTransport = {
      sendMail: async (mail) => {
        built = String((await json.sendMail(mail)).message)
      },
      verify: async () => true,
      close: () => json.close(),
    }
    await new SmtpMailer({ url: 'smtp://unused', from: 'no-reply@auth.test', transport }).send(
      message
    )
    const parsed = JSON.parse(built) as {
      from: { address: string }
      to: { address: string }[]
      subject: string
      text: string
      html: string
    }
    expect(parsed.from.address).toBe('no-reply@auth.test')
    expect(parsed.to.map((to) => to.address)).toEqual(['maya@northline.app'])
    expect(parsed).toMatchObject({
      subject: message.subject,
      text: message.text,
      html: message.html,
    })
  })

  test('propagates relay failures to the caller', async () => {
    const transport: SmtpTransport = {
      sendMail: async () => {
        throw new Error('connect ECONNREFUSED')
      },
      verify: async () => true,
      close: () => {},
    }
    const mailer = new SmtpMailer({ url: 'smtp://unused', from: 'a@b.test', transport })
    await expect(mailer.send(message)).rejects.toThrow('ECONNREFUSED')
  })

  test('verify greets the relay without sending, and propagates its refusal', async () => {
    let sent = 0
    let verified = 0
    const transport: SmtpTransport = {
      sendMail: async () => {
        sent += 1
      },
      verify: async () => {
        verified += 1
        return true
      },
      close: () => {},
    }
    await new SmtpMailer({ url: 'smtp://unused', from: 'a@b.test', transport }).verify()
    expect([verified, sent]).toEqual([1, 0])

    const refusing: SmtpTransport = {
      ...transport,
      verify: async () => {
        throw new Error('connect ECONNREFUSED')
      },
    }
    const mailer = new SmtpMailer({ url: 'smtp://unused', from: 'a@b.test', transport: refusing })
    await expect(mailer.verify()).rejects.toThrow('ECONNREFUSED')
  })

  test('builds a lazy pooled transport from the URL and closes it', () => {
    // Nothing listens on port 1: constructing and closing must not connect.
    const mailer = new SmtpMailer({ url: 'smtp://127.0.0.1:1', from: 'a@b.test' })
    expect(() => mailer.close()).not.toThrow()
  })
})
