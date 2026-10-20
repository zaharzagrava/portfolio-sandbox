---
id: conversion
title: Conversion
kind: term
status: draft
aliases: [conversions]
defined_for: J05-engagement-loop
rules_hash: 05c635994ee7
---
# Conversion
## Definition
A conversion is the credit a [link owner](link-owner.md) receives when an order placed through their [share link](referral-link.md) is paid. Checkout records the share reference from `ref` as the order's [attribution](checkout-attribution.md). The [`marketing-affiliate-conversions` consumer group](consumer-group.md) then turns the attributed `order.paid` event into a conversion. Each attributed paid order yields exactly one conversion, even if `order.paid` arrives twice or late. The conversion is credited first and can later be reversed by a full refund.

## Example
B creates a share link. Anonymous F follows it, checks out with `ref` set to B's code, and pays. B's conversions now show one new entry. A second copy of `order.paid` for the same order adds nothing (J05 AS-13, AS-15).

## Known gaps
- The spec does not say which fields a conversion holds, for example an amount or a commission.
- The spec does not say what a partial refund does to a conversion. Only a full refund is covered.
- "Conversion" also has a separate meaning in experiments: a signed-in purchase made after exposure (J05.R-18). That is a different record, and this page does not cover it.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
