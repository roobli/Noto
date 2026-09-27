- outer
  - a

    b
  ---
  - c

- atx then nest
  - a

    b
  ## Heading
  - c

- tight hr then nest
  - a
  ---
  - c

- quote then nest
  - a

    b
  > exit quote
  - c

- fence then nest
  - a

    b
  ```
  code
  ```
  - c

- html then nest
  - a

    b
  <div>block</div>
  - c

- hr more then nest
  - a

    b
  ---
  after exit
  - c

- family change after exit
  - a

    b
  ---
  * c

- mid ancestor
  - mid
    - deep

      body
    ---
    - sib

1. ordered
   1. nest

      body
   ---
   1. after

- [ ] task outer
  - nest

    body
  ---
  - after

- double interleave
  - a
  ---
  - b
  ## H
  - c

After nest-sibling following structural nest-exit.
