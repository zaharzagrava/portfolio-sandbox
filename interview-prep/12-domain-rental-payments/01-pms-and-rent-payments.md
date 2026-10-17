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
