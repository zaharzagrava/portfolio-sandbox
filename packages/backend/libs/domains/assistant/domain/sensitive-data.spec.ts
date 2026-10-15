import * as fc from 'fast-check';
import { containsSensitiveData, luhnValid } from './sensitive-data';

describe('S47 AS-06: sensitive data in a question', () => {
  it.each([
    ['a Visa card number', 'my card is 4111111111111111 please help'],
    ['a card number with spaces', 'pay with 4111 1111 1111 1111'],
    ['a card number with dashes', '5500-0000-0000-0004'],
    ['a 13 digit card number', '4222222222222'],
    ['a 19 digit card number', '6304000000000000000'],
    ['an api key', 'use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['an openai style key', 'sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['an AWS access key id', 'AKIAIOSFODNN7EXAMPLE is my key'],
    ['a private key block', '-----BEGIN RSA PRIVATE KEY-----\nMIIE'],
    ['a generic private key header', '-----BEGIN PRIVATE KEY-----'],
    ['a bearer token', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'],
  ])('S47 AS-06: %s is sensitive', (_name, text) => {
    expect(containsSensitiveData(text)).toBe(true);
  });

  it.each([
    ['plain prose', 'Does the Pixel 10 support eSIM and dual SIM?'],
    ['digits failing Luhn', 'order 4111111111111112 is late'],
    ['a short number', 'I have 12345 apples'],
    ['a phone number', 'call 555 0100 0199'],
    ['a model number', 'charger PX-45W-GAN2 works'],
    ['a year and a size', 'the 2026 model is 6.1 inches'],
    ['the word bearer', 'the bearer of this phone gets a discount'],
    ['sk inside a word', 'the task-force asked about disk-based storage'],
  ])('S47 AS-06: %s is not sensitive', (_name, text) => {
    expect(containsSensitiveData(text)).toBe(false);
  });
});

/** Check digit that makes `payload` + digit pass Luhn. */
function luhnCheckDigit(payload: string): string {
  for (let d = 0; d < 10; d++) if (luhnValid(payload + d)) return String(d);
  throw new Error('unreachable');
}

describe('S46 AS-53: sensitive data in input (30 positive / 30 negative)', () => {
  it.each([
    ['visa', 'my card is 4111111111111111'],
    ['visa with spaces', '4111 1111 1111 1111 expires soon'],
    ['mastercard dashes', 'pay 5500-0000-0000-0004 now'],
    ['mastercard 2-series', '2223003122003222'],
    ['amex 15', '378282246310005 is my amex'],
    ['amex 15 b', '371449635398431'],
    ['discover', '6011111111111117'],
    ['jcb', '3530111333300000'],
    ['diners 14', '30569309025904'],
    ['visa 13', '4222222222222'],
    ['visa debit', '4000056655665556'],
    ['unionpay', '6200000000000005'],
    ['iban DE', 'send it to DE89370400440532013000 please'],
    ['iban DE spaced', 'IBAN DE89 3704 0044 0532 0130 00'],
    ['iban GB', 'GB82WEST12345698765432'],
    ['iban FR', 'FR1420041010050500013M02606'],
    ['iban NL', 'NL91ABNA0417164300'],
    ['iban ES', 'ES9121000418450200051332'],
    ['iban IT', 'IT60X0542811101000000123456'],
    ['iban BE', 'BE68539007547034'],
    ['openai key', 'key: sk-abcdefghijklmnopqrstuvwxyz012345'],
    ['anthropic key', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['aws key', 'AKIAIOSFODNN7EXAMPLE'],
    ['pem rsa', '-----BEGIN RSA PRIVATE KEY-----'],
    ['pem ec', '-----BEGIN EC PRIVATE KEY-----\nabc'],
    ['pem plain', '-----BEGIN PRIVATE KEY-----'],
    ['pem openssh', '-----BEGIN OPENSSH PRIVATE KEY-----'],
    ['bearer header', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def'],
    ['bearer lowercase', 'bearer abcdefghijklmnop1234'],
    ['card inside a sentence', 'Hi, my number is 4012 8888 8888 1881, can you check my order?'],
  ])('S46 AS-53: positive: %s', (_n, text) => {
    expect(containsSensitiveData(text)).toBe(true);
  });

  it.each([
    ['order number 12 digits', 'order 123456789012 has shipped'],
    ['price', 'it costs €1,299.00 in total'],
    ['price large', 'the price is $12,999.99 or 1299.00 EUR'],
    ['luhn-invalid 16 digits', '4111111111111112'],
    ['luhn-invalid iban', 'DE89370400440532013001'],
    ['plain question', 'Which laptop has the best battery life?'],
    ['phone number', 'call +49 30 1234 5678'],
    ['phone number us', 'call (555) 010-0199'],
    ['date', 'delivered on 2026-10-15'],
    ['timestamp', '1760522400000 is a unix timestamp in ms'],
    ['short digits', 'room 4711'],
    ['model number', 'charger PX-45W-GAN2'],
    ['sku', 'SKU 00123-ABCD-9981'],
    ['year size', 'the 2026 model is 6.1 inches'],
    ['word bearer', 'the bearer of this phone gets a discount'],
    ['sk in word', 'the task-force asked about disk-based storage'],
    ['short sk', 'sk-short'],
    ['akia short', 'AKIA1234'],
    ['begin without key', '-----BEGIN CERTIFICATE-----'],
    ['country code words', 'DE and FR are shipping countries'],
    ['iban-like word', 'DE89 is the model code'],
    ['12 digits spaced', '1234 5678 9012'],
    ['20 digits', '12345678901234567890123'],
    ['coordinates', 'near 52.520008, 13.404954'],
    ['isbn text', 'the book ISBN is 978-3-16-148410-0'],
    ['weights', 'weighs 1.25 kg and 2400 mAh'],
    ['bullet list numbers', '1) 2) 3) 4) 5) 6) 7) 8) 9) 10) 11) 12) 13)'],
    ['german sentence', 'Welche Kopfhörer sind wasserdicht?'],
    ['emoji', 'love it 😀 thanks'],
    ['empty', ''],
  ])('S46 AS-53: negative: %s', (_n, text) => {
    expect(containsSensitiveData(text)).toBe(false);
  });

  it('S46 AS-53: property - any 13-19 digit Luhn-valid number is flagged, with spaces or dashes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 18 }),
        fc.constantFrom('', ' ', '-'),
        (digits, sep) => {
          const payload = digits.join('');
          const number = payload + luhnCheckDigit(payload);
          const grouped = number.match(/.{1,4}/g)!.join(sep);
          expect(containsSensitiveData(`my number ${grouped} thanks`)).toBe(true);
        },
      ),
    );
  });

  it('S46 AS-53: property - the same numbers with a wrong check digit are not flagged', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 12, maxLength: 18 }),
        fc.integer({ min: 1, max: 9 }),
        (digits, shift) => {
          const payload = digits.join('');
          const good = Number(luhnCheckDigit(payload));
          const bad = (good + shift) % 10;
          expect(containsSensitiveData(`ref ${payload}${bad}`)).toBe(false);
        },
      ),
    );
  });
});
