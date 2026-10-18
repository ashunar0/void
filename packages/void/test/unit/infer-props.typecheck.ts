import { describe, expectTypeOf, it } from 'vite-plus/test';
import { z } from 'zod';
import type { InferProps } from '../../src/pages/defer.ts';
import { defineHandler } from '../../src/runtime/handler.ts';

describe('InferProps', () => {
  it('drops Promise and Response from a plain loader', () => {
    const loader = defineHandler(async (c) => {
      if (c.req.query('missing')) {
        return c.notFound();
      }
      return { name: 'Alice' as string };
    });

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{ name: string }>();
  });

  it('drops Promise and Response from a loader with validators', () => {
    const loader = defineHandler.withValidator({
      params: z.object({ id: z.string() }),
    })(async (c, { params }) => {
      if (params.id === 'missing') {
        return c.notFound();
      }
      return { id: params.id };
    });

    expectTypeOf<InferProps<typeof loader>>().toEqualTypeOf<{ id: string }>();
  });
});
