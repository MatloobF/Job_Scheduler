-- Sample input for GENERATE_REPORT. Columns match the contract in src/db/seed.js.
CREATE TABLE sales (
  id SERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  amount NUMERIC NOT NULL
);
