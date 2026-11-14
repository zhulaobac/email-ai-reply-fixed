---
name: call-back-extractor
description: >
  Use this skill whenever the user pastes an email thread and wants to extract call-back
  information for a sales follow-up. Produces a text-format Call-Back Info Card, a
  chronological follow-up status summary, and a one-sentence call reason asking if the
  customer received the email or it went to spam.
  Triggers include: pasting an email thread with a prompt like "提取电话信息", "做成电话回访卡",
  "extract call info", "why do we need to call", or any request to summarize an email
  thread for a phone follow-up.
---

# Call-Back Extractor Skill

Read an email thread between a sales rep (Ella) and a customer, then produce three
structured outputs: a call-back info card, a follow-up status summary, and a
one-sentence call reason.

---

## Input

The user pastes a raw email thread (single email or full chain). The thread may be in
English, Chinese, or mixed.

The user may also include a short **context note** after the thread (e.g., "today is
Friday", "weekend is coming", "customer has a tight deadline"). Incorporate any such
notes into the call reason.

---

## Step 1 — Extract the Call-Back Info Card

Scan the entire thread and extract the fields below. Output each as a single `field: value` line.

Fields to extract:
- **Item Number** — Product SKU / item code (e.g., WG0501, WG2059)
- **Product Name** — Full product description as written in the email
- **Customer Name** — Name + company of the person Ella is writing to
- **PO #** — Purchase order number, if one has been placed
- **In-Hand Date** — Confirmed delivery deadline, or TBD if not stated
- **Ship To** — Delivery address if mentioned in the thread
- **Phone Number** — Any phone number found in the customer's signature or inquiry

If a field has no value, write "Not provided".

---

## Step 2 — Summarize the Follow-Up Status (in Chinese)

Write a short paragraph in **Chinese** (3–6 sentences) describing the email exchange in
**chronological order**:

- What the customer originally asked for
- What Ella has sent or done at each step
- The current state of the conversation (last action, what is still pending)

Be specific: name the actual materials sent (quote, photos, video, PI, VP, etc.) and
include dates where available.

End with a bold sentence stating what is **still outstanding** (e.g., no payment
received, no logo submitted, no reply from customer).

---

## Step 3 — One-Sentence Call Reason

Write **one concise sentence** structured as:

> "Ella has [actions taken] — but [customer has not replied / no response yet], so a
> follow-up call is needed to check if the customer has seen the previous email and
> whether it landed in spam."

Rules:
- List every meaningful action Ella has taken (quote sent, photos shared, VP approved,
  PI sent, followed up X times, etc.)
- State clearly that the customer has not responded yet
- The call purpose is always to check if the email was received and hadn't gone to spam
- If the user provided a context note (e.g., Friday / weekend / tight deadline),
  **incorporate it** to explain the urgency

---

## Step 4 — Weekend / Deadline Urgency (conditional)

If the context note or thread indicates a time-sensitive situation (e.g., today is
Friday, in-hand date is imminent, payment needed today), add a short **urgency note**
after the one-sentence call reason:

> **Urgency:** [1–2 sentences explaining why delay is costly — e.g., weekend means
> finance cannot process payment until Monday, pushing production start and putting the
> in-hand date at risk.]

Only include this block when urgency is genuinely present. Omit it for routine
follow-ups.

---

## Output Format

Present the three sections clearly separated with headers:

```
**Call-Back Info Card**
Item Number: WG7894
Product Name: ...
Customer Name: ...
PO #: Not provided
...

**Current Follow-Up Status**
[paragraph in Chinese]

**One-Sentence Call Reason**
[sentence]

**Urgency:** [only if applicable]
```

Answer in **English** unless the user explicitly requests Chinese.
