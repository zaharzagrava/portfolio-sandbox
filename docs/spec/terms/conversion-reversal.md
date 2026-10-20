---
id: conversion-reversal
title: Conversion reversal
kind: term
status: draft
aliases: [reverse]
defined_for: J05-engagement-loop
rules_hash: 6b9908cd4ea8
---
# Conversion reversal
## Definition
A [conversion](conversion.md) reversal undoes the credit on an existing conversion after the attributed order is fully refunded. The [conversion consumer](conversion-consumer.md) reacts to [`order.refunded`](order-refunded-event.md) and moves the conversion from credited to reversed. The reversal stays visible on the owner's conversion rather than removing it. Keeping it visible, presumably for an audit trail, is design intent (not stated in the spec). A declined or cancelled order never creates a conversion, so it has nothing to reverse (J05.R-13).

## Example
F's order through B's link is paid, and B has one credited conversion. The order is then fully refunded. After the conversion consumer runs, B's conversion shows the reversal (J05 AS-19).

## Known gaps
- The spec does not say what happens on a partial refund.
- The spec does not say whether a reversal publishes its own event, or whether it changes the link's stats.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
