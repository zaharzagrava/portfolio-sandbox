# Seller overview, failed-section picture (round 2)

- The saved picture was taken while the live panel already showed its bar strip (44 px taller).
- The test took the picture without waiting for that strip. Sometimes the live feed connected before the picture (strip there, test passes), sometimes after (44 px shorter, test fails). The live panel's frame is masked, but its height still counts.
- Fix: the test now waits for the strip (same wait the with-data test uses) before the picture. No baseline change, no masks or thresholds touched.
- I saw the failure on phone as 44 px (1329 vs 1285). The 4 px desktop failure did not show up again in 6+3 desktop runs; it was probably the same timing effect (live panel or a neighbour not yet settled), not separately proven.
- Result: repeat-each=6 on both projects all passed.
