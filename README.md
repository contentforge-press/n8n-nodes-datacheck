# n8n-nodes-data-validator

Catch the data problems that break your n8n workflow **before** they reach the next node.

## The problem

Most n8n workflows fail silently on bad data:

- Two spreadsheet exports use different ticket ID formats → `Merge` returns fewer rows, no error
- A date like `2026-02-30` parses fine in JavaScript → the row lands in your database with a nonsense date
- An amount like `"$1,250.00"` fails a `Number()` cast → becomes `NaN` → silently written as null
- A required field is `N/A` instead of empty → passes a null check → poisons downstream joins

None of these throw. They just make your reports wrong.

## What this node does

Drop it between any two nodes. It checks every item and routes the bad ones to a second output.

**Free checks:**
- Duplicate rows and duplicate key values
- Empty required fields
- Placeholder values (`N/A`, `null`, `-`, `TBD`)
- Values that fail numeric parsing in a numeric column
- **Dates that parse but don't exist** (`2026-02-30`, `2026-13-45`)
- Leading/trailing whitespace that breaks string joins

**Outputs:**
1. `Valid` — a summary item plus the clean rows
2. `Issues found` — rows with high-severity problems, annotated with the reason and the fix

## Usage

```json
{
  "nodes": [
    {
      "name": "Data Validator",
      "type": "dataValidator",
      "parameters": {
        "operation": "validate",
        "keyColumn": "order_id",
        "requiredColumns": "email, amount",
        "onIssues": "split"
      }
    }
  ]
}
```

## Install

In n8n: **Settings → Community Nodes → Install** → `n8n-nodes-data-validator`

Or:
```bash
npm install n8n-nodes-data-validator
```

## Example

Input:
```
order_id,email,amount,date
A-1001,john@ex.com,1250,2026-10-01
A-1002,N/A,890,2026-02-30
A-1002,emma@shop.co,abc,2026-10-02
```

Output `Valid`: row 1
Output `Issues found`:
- Row 2: `email` is a placeholder (`N/A`), `date` is `2026-02-30` which does not exist
- Row 3: `order_id` repeats `A-1002` — a join on this column will produce duplicate rows, `amount` is `abc` in a numeric column

## Pro

The free version covers single-table checks. Pro adds:

- **Cross-table consistency** — verify keys match between two branches before you merge
- **Alerts** — Slack, email or webhook when a run finds problems
- **Files up to 5M rows**

One-time $49, no subscription: https://checkout.dodopayments.com/buy/pdt_0Nq62Ecr9PnrPukjAEhaM?ref=n8n-node

## License

MIT
