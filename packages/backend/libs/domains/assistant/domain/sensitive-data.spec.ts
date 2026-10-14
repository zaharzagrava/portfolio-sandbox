import { containsSensitiveData } from './sensitive-data';

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
