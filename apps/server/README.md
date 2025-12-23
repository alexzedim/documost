## Installation

```bash
$ npm install
```

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Migrations

````bash
# This creates a new empty migration file named 'init'
$ npm run migration:create --name=init

# Generates 'init' migration file from existing entities to update the database schema
$ npm run migration:generate --name=init

# Runs all pending migrations to update the database schema
$ npm run migration:run

# Reverts the last executed migration
$ npm run migration:revert

# Reverts all migrations
$ npm run migration:revert

# Shows the list of executed and pending migrations
$ npm run migration:show



## Test

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
````
