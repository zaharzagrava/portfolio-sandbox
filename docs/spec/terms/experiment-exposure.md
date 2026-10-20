---
id: experiment-exposure
title: Experiment exposure
kind: term
status: draft
aliases: [exposure]
defined_for: J05-engagement-loop
rules_hash: 3fac1f4f9994
---
# Experiment exposure
## Definition
An exposure records that a buyer was shown one [variant](experiment-variant.md) of an experiment. It is the starting point for [conversion](conversion.md): a signed-in purchase converts only if the same buyer's exposure came first. Exposures are counted per variant, and [replaying events](event-replay.md) must not change those counts. Exposures by [anonymous visitors](visitor.md) do not join the experiment.

## Example
Buyer B is shown variant A (illustrative name), and the exposure is recorded. B then pays an order, so one conversion is counted for variant A. If B had paid before any exposure, no conversion would count.

## Known gaps
- The spec does not say which event carries an exposure or which topic it arrives on.
- The spec does not say whether a second exposure of the same buyer counts again or is merged.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
