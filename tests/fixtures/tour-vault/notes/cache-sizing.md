# Cache sizing

Notes from load testing the read path. Every number below came from a fifty
minute run against the staging cluster, not from a spreadsheet.

> [!NOTE]
> The working set is the figure that matters. A cache sized to the total
> dataset spends its budget on entries nobody reads.

## What we measured

| Tier | Size | Hit rate | p99 |
| --- | ---: | ---: | ---: |
| L1 in-process | 256 MB | 71% | 0.8 ms |
| L2 shared | 4 GB | 93% | 2.4 ms |
| Origin | 1.2 TB | 0% | 48 ms |

The blended hit rate is $0.71 + (1 - 0.71) \times 0.93 = 0.98$, which matches
the observed 97.6% within run-to-run noise.

## Budget

- [x] Cap L1 at 256 MB per node
- [x] Alert when L2 evictions exceed 2% of reads
- [ ] Re-run after the index change
- [ ] Add a dashboard for the origin miss path

## Eviction loop

```ts
function evict(cache: Lru, budget: number): void {
  while (cache.bytes > budget) cache.dropOldest();
}
```
