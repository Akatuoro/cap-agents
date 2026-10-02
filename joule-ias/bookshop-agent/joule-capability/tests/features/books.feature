Feature: Books catalog agent

    Background:
        Given I log in
        And I start a new conversation

    Scenario: List books
        Given I set response polling to 20
        When I say "list books"
        Then response has 1 message
        And first message has type text
