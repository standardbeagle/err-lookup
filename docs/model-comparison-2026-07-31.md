# Model comparison — sindresorhus/is

| metric | fable | glm-5.2 | kimi-k2.7 | deepseek-flash |
|---|---|---|---|---|
| records | 100 | 109 | 101 | 92 |
| with errorCode | 0% | 0% | 0% | 0% |
| avg doc chars | 300 | 356 | 290 | 348 |
| short docs (<100ch) | 0% | 0% | 0% | 0% |
| avg solutions | 3.5 | 4 | 3.4 | 3.8 |
| no solutions | 0% | 0% | 0% | 0% |
| example fix | 100% | 100% | 100% | 83% |
| source extracted | 100% | 100% | 100% | 100% |
| defense strategy | 100% | 100% | 100% | 89% |
| avg prevention tips | 3.2 | 3.4 | 3.9 | 3.7 |
| avg tags | 4 | 4.7 | 5.1 | 3.6 |
| discovery time | 2.2m | 1.8m | 2.5m | 1.2m |
| enrichment time | 27.8m | 25.0m | 30.2m | 17.6m |
| defense time | 15.7m | 18.8m | 18.6m | 12.2m |
| verify time | 0.1m | 2.3m | 1.4m | 14.4m |
