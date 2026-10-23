# Cache invalidation

Entries are versioned by the write that produced them. A reader that sees an
older version than the one it asked for treats the entry as a miss.
