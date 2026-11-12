import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSchemaErrors, validateSchema } from "../schema.ts";
import { PROTOCOL_VERSION } from "../catalog.ts";
import { check, loadSchemas } from "../schemas.ts";

const poppy = {
    protocol_version: PROTOCOL_VERSION,
    organization: { name: "Alpine Retail", domain: "alpine-retail.example" },
    auth: {
        issuer: "https://auth.alpine-retail.example",
        scopes: { "orders:read": "See your orders and returns" },
    },
    agent: {
        protocols: [
            { type: "poppy", endpoint: "https://api.alpine-retail.example/poppy/conversations" },
        ],
    },
};

test("every schema file parses and declares 2020-12", () => {
    const schemas = loadSchemas();
    assert.ok(Object.keys(schemas).length >= 19);
    for (const [name, schema] of Object.entries(schemas)) {
        assert.equal(
            (schema as { $schema?: string }).$schema,
            "https://json-schema.org/draft/2020-12/schema",
            name,
        );
    }
});

test("rich summaries preserve the text fallback and allow unknown styles", () => {
    const operation = {
        operation_id: "buy_1",
        revision: "rev_1",
        summary: "Buy one guide for $12.00 USD.",
        expires_at: "2026-10-08T12:20:00-07:00",
    };
    assert.deepEqual(check("operation.schema.json", operation), []);
    for (const rich_summary of [
        [],
        [{ style: "com.example.checkout", checkout: { id: "quote_1" } }],
        [{ style: "com.example.receipt", items: [{ title: "Guide" }] }],
    ]) {
        assert.deepEqual(check("operation.schema.json", { ...operation, rich_summary }), []);
    }
    const { summary: _summary, ...withoutText } = operation;
    assert.ok(
        check("operation.schema.json", {
            ...withoutText,
            rich_summary: [{ style: "com.example.receipt", title: "Guide" }],
        }).some((error) => error.path === "/summary"),
    );
    for (const rich_summary of [[{}], [{ style: "" }], [{ style: 1 }], ["receipt"], {}]) {
        assert.ok(check("operation.schema.json", { ...operation, rich_summary }).length > 0);
    }
});

test("checkout summaries follow version 1 of the checkout style", () => {
    const usd = (amount: string) => ({ amount, currency: "USD" });
    const checkout = {
        style: "checkout",
        version: "1",
        amount_due_now: usd("12.00"),
        conditional_charge: { max: usd("25.00"), terms: "Charged if you miss your pickup." },
        items: [
            {
                name: "Trail Guide",
                quantity: 1,
                options: ["Format: PDF"],
                unit_amount: usd("12.00"),
                line_total: usd("12.00"),
                seller: "Alpine Maps",
                obligations: [
                    {
                        kind: "recurring",
                        amount: usd("3.00"),
                        interval: "month",
                        terms: "Cancel anytime in your account settings.",
                    },
                ],
            },
        ],
        subtotal: usd("12.00"),
        obligations: [{ kind: "financing", total: usd("12.00"), terms: "Four payments." }],
        fulfillment: { destination: "Home", service: "Standard", arrival: "Nov 18" },
        account: "buyer@example.net",
        contact: "buyer@example.net",
        payment_method: "Visa ending in 4242",
        not_applicable: [{ field: "fulfillment", reason: "Digital download." }],
    };
    assert.deepEqual(check("checkout-summary.schema.json", checkout), []);
    assert.deepEqual(
        check("checkout-summary.schema.json", {
            style: "checkout",
            version: "1",
            amount_due_now: { amount: "1980", currency: "JPY" },
        }),
        [],
    );
    for (const invalid of [
        { ...checkout, version: "2" },
        { ...checkout, style: "com.example.checkout" },
        { ...checkout, amount_due_now: undefined },
        { ...checkout, amount_due_now: 12 },
        { ...checkout, amount_due_now: usd("1,200.00") },
        { ...checkout, amount_due_now: usd("12,00") },
        { ...checkout, amount_due_now: { amount: "12.00", currency: "usd" } },
        { ...checkout, items: [{ name: "Trail Guide" }] },
        { ...checkout, items: [{ name: "Trail Guide", quantity: 0 }] },
        { ...checkout, obligations: [{ kind: "recurring", terms: "Monthly." }] },
        { ...checkout, obligations: [{ kind: "lease", terms: "Monthly." }] },
        { ...checkout, not_applicable: [{ field: "items", reason: "None." }] },
        { ...checkout, payment_method: { card_number: "4242424242424242" } },
        { ...checkout, credential: { token: "tok_1" } },
        { ...checkout, actions: [] },
    ]) {
        assert.ok(
            check("checkout-summary.schema.json", invalid).length > 0,
            JSON.stringify(invalid),
        );
    }
});

test("a valid poppy.json passes", () => {
    assert.deepEqual(check("poppy.schema.json", poppy), []);
});

test("type, required, and pattern errors have paths and plain messages", () => {
    const errors = check("poppy.schema.json", {
        ...poppy,
        protocol_version: 1,
        organization: { name: "A", domain: "https://a.example/" },
    });
    const paths = errors.map((e) => e.path);
    assert.ok(paths.includes("/protocol_version"));
    assert.ok(paths.includes("/organization/domain"));
    assert.match(errors.find((e) => e.path === "/organization/domain")!.message, /domain name/);
    assert.ok(
        formatSchemaErrors(errors).every((line) => typeof line === "string" && line.length > 0),
    );
});

test("anyOf of required-only branches says which fields are needed", () => {
    const { agent: _agent, ...withoutInterfaces } = poppy;
    const errors = check("poppy.schema.json", withoutInterfaces);
    assert.ok(
        errors.some((e) => /at least one of/.test(e.message)),
        JSON.stringify(errors),
    );
});

test("fragment references resolve, such as the Session JWT payload", () => {
    const payload = {
        iss: "https://agent.example/agent.json",
        aud: "https://auth.example",
        sid: "abcdefghijklmnopqrstuv",
        sub: "usr_1",
        jti: "abcdefghijklmnopqrstuv",
        htm: "POST",
        htu: "https://a.example/poppy/feedback",
        iat: 1,
    };
    assert.deepEqual(check("session-jwt.schema.json#/$defs/payload", payload), []);
    const bad = check("session-jwt.schema.json#/$defs/payload", {
        ...payload,
        htu: "https://a.example/poppy/feedback?x=1",
    });
    assert.equal(bad.length, 1);
    assert.match(bad[0].message, /without a query or fragment/);
});

test("core keywords", () => {
    const schema = {
        type: "object",
        properties: {
            n: { type: "integer", minimum: 1, maximum: 3 },
            s: { type: "string", minLength: 2, enum: ["ab", "cd"] },
            a: { type: "array", items: { const: 1 }, minItems: 1 },
            x: false,
        },
        required: ["n"],
        additionalProperties: false,
    };
    assert.deepEqual(validateSchema(schema, { n: 2, s: "ab", a: [1] }), []);
    const errors = validateSchema(schema, { n: 5, s: "zz", a: [2], x: 1, extra: true });
    const paths = errors.map((e) => e.path).sort();
    assert.deepEqual(paths, ["/a/0", "/extra", "/n", "/s", "/x"]);
    assert.match(errors.find((e) => e.path === "/x")!.message, /must not be present/);
    assert.deepEqual(validateSchema(schema, {}), [{ path: "/n", message: "is required" }]);
});

test("$ref to another schema by file name", () => {
    const refs = { "id.schema.json": { type: "string", pattern: "^[a-z]+$" } };
    assert.deepEqual(validateSchema({ $ref: "id.schema.json" }, "abc", refs), []);
    assert.equal(validateSchema({ $ref: "id.schema.json" }, "ABC", refs).length, 1);
});

test("events responses accept a null cursor", () => {
    const body = {
        conversation_id: "cnv_1",
        events: [],
        cursor: null,
        has_more: false,
        working: false,
        handoff: "none",
        responder: "agent",
        closed: false,
    };
    assert.deepEqual(check("events-response.schema.json", body), []);
});

test("a Direct Conversation can accept a user_requested event without a message", () => {
    const acceptance = {
        id: "req_1",
        parent_conversation_id: "cnv_1",
        user_requested_event_id: "evt_1",
    };
    const message = { author: { type: "human" }, text: "Hello" };
    for (const request of [acceptance, { ...acceptance, message }, { id: "msg_1", message }]) {
        assert.deepEqual(check("conversation-request.schema.json", request), []);
    }
    assert.deepEqual(
        check("conversation-message-request.schema.json", { id: "msg_1", message }),
        [],
    );
    assert.ok(
        check("conversation-message-request.schema.json", acceptance).some(
            (e) => e.path === "/message",
        ),
    );
    for (const request of [
        {},
        { message },
        { id: "req_1", parent_conversation_id: "cnv_1" },
        { id: "req_1", user_requested_event_id: "evt_1" },
        { id: "req_1", user_requested_event_id: "evt_1", message },
        { ...acceptance, id: "not/an/id" },
        { ...acceptance, user_requested_event_id: "not/an/id" },
        { ...acceptance, parent_conversation_id: "" },
        { ...acceptance, message: { author: { type: "human" } } },
    ]) {
        assert.ok(
            check("conversation-request.schema.json", request).length > 0,
            JSON.stringify(request),
        );
    }
});

test("only AI-written messages say what they took into account", () => {
    const company = { role: "company", as_of_request: "msg_Hc72PwZn4eKs1QxB", text: "Yes." };
    assert.deepEqual(check("message.schema.json", { ...company, author: { type: "agent" } }), []);
    assert.notDeepEqual(
        check("message.schema.json", { ...company, author: { type: "human" } }),
        [],
    );
    const user = { role: "user", as_of_cursor: "evt_c2", text: "Done." };
    assert.deepEqual(check("message.schema.json", { ...user, author: { type: "agent" } }), []);
    assert.notDeepEqual(check("message.schema.json", { ...user, author: { type: "human" } }), []);
    assert.notDeepEqual(
        check("message.schema.json", {
            ...user,
            as_of_request: "msg_x",
            author: { type: "agent" },
        }),
        [],
    );
});
