# Domain: Rent Payments and Property Management Software (PMS)

Business context for rental-fintech roles: who the parties are, how money flows, what a PMS is, and why rent payment companies exist next to PMS vendors. Architecture for integrating PMSs: [practice/01](../practice/01-pms-webhook-ingestion.md).

---

## 1. PMS (Property Management Software)

The system a property manager (or a self-managing landlord) runs their buildings in: **Yardi, AppFolio, Buildium, Entrata, RealPage, MRI**. It holds properties, units, tenants, leases, rent charges, balances and the **tenant ledger** (what each tenant owes and paid), plus maintenance and owner accounting. Every PMS models these concepts differently, which is why integrations need a canonical model and one adapter per PMS.

## 2. Who's who

| Party | Who | Role for a rent fintech |
|---|---|---|
| **Owner / landlord** | whoever owns the property: an individual investor, a family, a fund or REIT. Not necessarily who built it | wants the rent, minus costs |
| **Property management (PM) company** | hired by the owner to run the property: find tenants, sign leases, collect rent, maintenance; takes a fee (often ~8–10% of rent). Small landlords sometimes self-manage (owner = manager) | **the customer** |
| **PMS vendor** | the software company (Yardi, AppFolio…). The PM company **licenses** the PMS, it doesn't own it | **the integration partner** |
| **Tenant / renter** | lives there, pays rent | pays **through the fintech** |

## 3. What the rent fintech does

The **payment layer on top of the PMS**. The PMS is the property manager's back office (who lives where, what they owe); the fintech moves the money: collects rent (card, bank transfer, open banking), handles failures, retries and chargebacks, pays out, and **posts every payment back into the PMS** so the tenant ledger and accounting are right. Like Stripe, specialised for rent and plugged into each PMS. So every integration has two directions: **read** what's owed (leases, charges), **write** what was paid.

**End-to-end flow**
```
tenant pays → we collect (card / bank / open banking) → money settles
            → we post the payment into the PMS (tenant ledger shows "paid")
            → we pay out to the verified payout account
            → the manager sees it reconciled in their PMS
```
- Payouts go either **through the manager** (all rent to the PM company's trust account; they pay the owner minus their fee) or **split directly** (owner's share to the owner, fee to the PM company). Which one is per-customer configuration.
- **The payout account is onboarded and verified with us** (KYC/AML, bank account verification), not blindly taken from PMS data. A changed bank account in a webhook payload is a classic fraud vector: tamper with the PMS, redirect the rent.

**Which source owns which fact**
| Fact | Source of truth |
|---|---|
| What is owed: leases, rent charges, balances, who lives where | the **PMS** (accept, but validate) |
| What was paid: payment status, refunds, chargebacks | **our ledger + the payment provider / bank**, never the PMS payload |
| Where money goes: payout accounts | **us** (verified at onboarding) |

## 4. Why doesn't the PMS do payments itself?

Some do (AppFolio and Yardi have their own payment products), so a rent fintech is partly a **partner**, partly a **competitor** of PMS vendors. Specialists exist because:
- payments are **regulated**: money-transmitter licences, KYC/AML, PCI DSS for cards;
- payments are **risky**: bank returns, chargebacks, fraud need dedicated handling;
- the value is in **products a PMS doesn't build**: flexible/split rent, deposit alternatives, rent guarantees, credit building, better tenant UX ("trust between renters and landlords");
- **one integration across many PMSs**: large managers often run mixed portfolios on several PMSs.

**Questions to ask in the CTO / hiring-manager round**
- "How do you position against the PMSs' built-in payments, and which PMS integrations matter most?"
- "Do most PMS partners give you webhooks with sequence numbers, or do you mostly poll?"
- "How is a new customer onboarded today, and where does it take the longest?"

---

## 5. Open banking basics

**What it is.** Regulation forces banks to give licensed third parties API access to a customer's account, **only with that customer's consent**. EU/UK: PSD2 (UK: Open Banking standard); Israel: Bank of Israel open-banking directive. Before it, apps used screen scraping with the user's bank password; open banking replaces that with tokens and the password never leaves the bank.

**Two kinds of access**
| | AIS (account information) | PIS (payment initiation) |
|---|---|---|
| Does | read: account holder name, account number/IBAN, balance, transactions | start a bank transfer from the user's account |
| Consent | ongoing, with an **expiry** (length set by regulator/bank; EU allows up to 180 days between re-authentications via a provider, UK uses 90-day reconfirmation; check the regime) | per payment (or a mandate for recurring) |
| Rent use | verify account ownership, balance check before a debit, match transfers to rent | pay rent as an instant bank transfer |

**Aggregators.** Nobody integrates hundreds of banks one by one. Providers like **Plaid, TrueLayer, Tink, Salt Edge** (plus local Israeli ones) give one API across many banks. You talk to the aggregator; it talks to the banks.

**Consent flow (standard OAuth shape)**
1. Your app asks the aggregator for a link session → user is redirected to the aggregator/bank UI.
2. User logs in **at the bank**, sees what is requested (accounts, data types, duration), approves.
3. Bank/aggregator redirects the **browser** back to your redirect URL with a **one-time code** (short-lived, single use). This is a redirect, not a webhook: the code arrives via the user's browser, so it carries no secret. Your backend exchanges it server-to-server, using your client secret, for tokens / a connection id. The browser never sees the tokens.
4. Your backend calls the data APIs with that token. Many providers also send **webhooks** ("new transactions available", "consent expiring", "login required").

**Tokens vs consent.** Two different clocks:
- **Access token**: short-lived (minutes–hours). Renewed with a **refresh token** (some providers rotate it: each refresh token works once), or the aggregator manages tokens and hands you a long-lived connection token.
- **Consent**: the user's permission; ends at its expiry or when the user revokes it at the bank. Refreshing a token can't extend it; only the user can, by re-consenting.
- **Open-banking consent ≠ debit authorization.** A bank debit (ACH / direct debit) runs on the account number plus the tenant's signed debit authorization (mandate), through the payment provider. It doesn't use the open-banking token. So when AIS consent expires you lose reads (ownership check, balance check, transaction matching), not the ability to collect rent, as long as the debit flow was never built to depend on the token.

**Data quirks**
- Transactions arrive as **pending**, later **posted**; some banks give the posted one a **new ID**.
- History depth on first link differs by bank (roughly 90 days to 24 months).
- Bank APIs are slow and flaky; balances can be cached or stale.
