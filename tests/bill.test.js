import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billRequest, BILL_SCHEMA } from '../src/meterPrompt.js';

test('PDF bills are sent as documents, photos as images', () => {
  const pdf = billRequest({ fileBase64: 'AAA', mediaType: 'application/pdf' });
  assert.equal(pdf.messages[0].content[0].type, 'document');
  assert.equal(pdf.messages[0].content[0].source.media_type, 'application/pdf');
  const img = billRequest({ fileBase64: 'AAA', mediaType: 'image/jpeg' });
  assert.equal(img.messages[0].content[0].type, 'image');
  assert.equal(img.output_config.format.schema, BILL_SCHEMA);
});

test('bill schema requires every field (structured outputs)', () => {
  const check = (schema) => {
    if (schema.type === 'object') {
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      assert.equal(schema.additionalProperties, false);
      Object.values(schema.properties).forEach(check);
    }
  };
  check(BILL_SCHEMA);
});
