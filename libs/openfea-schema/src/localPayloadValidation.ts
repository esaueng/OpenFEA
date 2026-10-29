import { z } from "zod";

const arraySizeSchemas = new WeakMap<z.ZodArray, z.ZodType>();
const anyValue = z.unknown();

/** Stop a cross-reference validator without changing its public diagnostics. */
export function firstIssueOnly<T>(refinement: (value: T, context: z.RefinementCtx) => void) {
  return (value: T, context: z.RefinementCtx): void => {
    const stop = {};
    try {
      refinement(value, {
        ...context,
        addIssue(issue) {
          context.addIssue(issue);
          throw stop;
        }
      });
    } catch (error) {
      if (error !== stop) throw error;
    }
  };
}

/**
 * Local files and browser storage need only one refusal, not a diagnostic for
 * every invalid entry. Walk children before invoking the normal parser so even
 * continuable checks (for example positive numbers) stop at the first failure.
 * Use the original schema for accepted output, including defaults/migrations.
 * This helper covers the local project's schema family: union branches share
 * their unbounded child schemas, and caught inputs have the guard below.
 */
export function safeParseLocalPayload<T extends z.ZodType>(schema: T, value: unknown): z.ZodSafeParseResult<z.output<T>> {
  if (!validChildrenFirst(schema, value)) {
    return {
      success: false,
      error: new z.ZodError([{ code: "custom", path: [], message: "Invalid local payload." }]) as z.ZodError<z.output<T>>
    };
  }
  return schema.safeParse(value);
}

/** Put this inside a catch: corrupt optional summaries must still be dropped. */
export function boundedLocalInput<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, context) => {
    if (validChildrenFirst(schema, value)) return value;
    context.addIssue({ code: "custom", message: "Invalid local payload.", fatal: true });
    return z.NEVER;
  }, schema);
}

function validChildrenFirst(schema: z.ZodType, value: unknown): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    if (value !== undefined && !validChildrenFirst(schema.unwrap() as z.ZodType, value)) return false;
  } else if (schema instanceof z.ZodNullable) {
    if (value !== null && !validChildrenFirst(schema.unwrap() as z.ZodType, value)) return false;
  } else if (schema instanceof z.ZodPipe) {
    if (!validChildrenFirst(schema.in as z.ZodType, value)) return false;
    const input = (schema.in as z.ZodType).safeParse(value);
    return input.success && validChildrenFirst(schema.out as z.ZodType, input.data);
  } else if (schema instanceof z.ZodUnion) {
    return schema.options.some((option) => validChildrenFirst(option as z.ZodType, value));
  } else if (schema instanceof z.ZodArray && Array.isArray(value)) {
    let sizeSchema = arraySizeSchemas.get(schema);
    if (!sizeSchema) {
      // Retain only native upper-size checks, so no custom refinement sees
      // unparsed children and existing oversized inputs still fail early.
      const checks = schema.def.checks?.filter((check) =>
        check instanceof z.core.$ZodCheckMaxLength || check instanceof z.core.$ZodCheckLengthEquals
      );
      sizeSchema = checks?.length ? schema.clone({ ...schema.def, checks, element: anyValue }) : anyValue;
      arraySizeSchemas.set(schema, sizeSchema);
    }
    if (!sizeSchema.validate(value)) return false;
    for (const item of value) {
      if (!validChildrenFirst(schema.element as z.ZodType, item)) return false;
    }
  } else if (schema instanceof z.ZodObject && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const shape = schema.shape;
    for (const key in shape) {
      if (!validChildrenFirst(shape[key] as z.ZodType, record[key])) return false;
    }
    const catchall = schema.def.catchall as z.ZodType | undefined;
    if (catchall && !(catchall instanceof z.ZodUnknown)) {
      for (const key in record) {
        if (Object.hasOwn(record, key) && !Object.hasOwn(shape, key)
          && !validChildrenFirst(catchall, record[key])) return false;
      }
    }
  } else if (schema instanceof z.ZodRecord && value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (!validChildrenFirst(schema.keyType as z.ZodType, key)
        || !validChildrenFirst(schema.valueType as z.ZodType, (value as Record<string, unknown>)[key])) return false;
    }
  } else if (schema instanceof z.ZodTuple && Array.isArray(value)) {
    const { items, rest } = schema.def;
    if ((!rest && value.length > items.length) || value.length < items.length) return schema.validate(value);
    for (let index = 0; index < value.length; index++) {
      const item = items[index] ?? rest;
      if (item && !validChildrenFirst(item as z.ZodType, value[index])) return false;
    }
  }
  // The only caught schema in local payloads wraps boundedLocalInput above;
  // parsing that catch is bounded even when its original input is corrupt.
  // Cross-reference refinements must also return after their first issue.
  return schema.validate(value);
}
