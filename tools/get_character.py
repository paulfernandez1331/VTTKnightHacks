import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

try:
    import requests
except ModuleNotFoundError:
    print(
        "The requests package is not installed. Run pip install requests.",
        file=sys.stderr,
    )
    sys.exit(1)

from convert_character_format import convert_character


def get_character_id(user_input: str) -> int:
    """
    Extract a character ID from either an integer or a D&D Beyond URL.

    Accepted examples:
        123456789
        https://www.dndbeyond.com/characters/123456789
        https://www.dndbeyond.com/characters/123456789/character-sheet
    """
    value = user_input.strip().strip('"')

    if not value:
        raise ValueError("No character ID or URL was entered.")

    # If the user entered only an ID, validate and return it.
    if value.isdigit():
        character_id = int(value)

        if character_id <= 0:
            raise ValueError("The character ID must be greater than zero.")

        return character_id

    # Otherwise, try to extract the ID from a D&D Beyond URL.
    parsed_url = urlparse(value)
    path_parts = [
        part
        for part in parsed_url.path.split("/")
        if part
    ]

    try:
        characters_index = path_parts.index("characters")
        id_text = path_parts[characters_index + 1]
        character_id = int(id_text)
    except (ValueError, IndexError):
        raise ValueError(
            "Enter a character ID or a valid D&D Beyond character URL."
        )

    if character_id <= 0:
        raise ValueError("The character ID must be greater than zero.")

    return character_id


def download_character(character_id: int) -> dict:
    """
    Download a character response from D&D Beyond.
    """
    url = (
        "https://character-service.dndbeyond.com/"
        f"character/v5/character/{character_id}"
    )

    response = requests.get(
        url,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
        },
        timeout=30,
    )

    response.raise_for_status()

    try:
        ddb_data = response.json()
    except requests.exceptions.JSONDecodeError as error:
        raise RuntimeError(
            "D&D Beyond did not return valid JSON."
        ) from error

    if not isinstance(ddb_data, dict):
        raise RuntimeError(
            "D&D Beyond returned an unexpected response."
        )

    if ddb_data.get("success") is False:
        message = ddb_data.get(
            "message",
            "D&D Beyond did not return the character.",
        )
        raise RuntimeError(message)

    if not isinstance(ddb_data.get("data"), dict):
        raise RuntimeError(
            "The response does not contain character data."
        )

    return ddb_data


def save_converted_character(
    converted_character: dict,
    output_path: Path,
) -> None:
    """
    Save only the converted character.

    The target format expects a list of characters, so the converted
    character is placed inside a list before it is saved.
    """
    output_data = [converted_character]

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with output_path.open("w", encoding="utf-8") as output_file:
        json.dump(
            output_data,
            output_file,
            indent=2,
            ensure_ascii=False,
        )


def convert_and_save(user_input: str, output_path: Path) -> None:
    """Download a public character and write the converted list."""
    character_id = get_character_id(user_input)
    ddb_data = download_character(character_id)
    converted_character = convert_character(ddb_data)
    save_converted_character(converted_character, output_path)


def failure_message(error: BaseException) -> str:
    """The same sentences the interactive converter prints."""
    if isinstance(error, ValueError):
        return f"Invalid input: {error}"

    if isinstance(error, requests.exceptions.Timeout):
        return "The request timed out. Please try again."

    if isinstance(error, requests.exceptions.ConnectionError):
        return (
            "Could not connect to D&D Beyond. "
            "Check your internet connection."
        )

    if isinstance(error, requests.exceptions.HTTPError):
        status_code = error.response.status_code

        if status_code in (401, 403, 404):
            return (
                "The character could not be accessed. "
                "Make sure it exists and is set to public."
            )

        return f"D&D Beyond returned HTTP error {status_code}."

    if isinstance(error, requests.exceptions.RequestException):
        return f"The network request failed: {error}"

    if isinstance(error, KeyError):
        return (
            "The character response is missing information "
            f"needed by the converter: {error}"
        )

    if isinstance(error, RuntimeError):
        return f"Conversion failed: {error}"

    if isinstance(error, OSError):
        return f"The output file could not be written: {error}"

    return f"Conversion failed: {error}"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="D&D Beyond Character Converter",
    )
    parser.add_argument(
        "--url",
        help="Character ID or D&D Beyond character URL",
    )
    parser.add_argument(
        "--out",
        help="File path for the converted character JSON",
    )
    args = parser.parse_args()

    # The board passes both flags so this never waits on input().
    if args.url is not None or args.out is not None:
        if not args.url or not args.out:
            print(
                "Both --url and --out are required together.",
                file=sys.stderr,
            )
            sys.exit(1)

        try:
            convert_and_save(args.url, Path(args.out))
        except (
            ValueError,
            requests.exceptions.RequestException,
            KeyError,
            RuntimeError,
            OSError,
        ) as error:
            print(failure_message(error), file=sys.stderr)
            sys.exit(1)
        return

    print("D&D Beyond Character Converter")
    print("------------------------------")

    user_input = input(
        "Enter the character ID or D&D Beyond character URL: "
    )

    try:
        character_id = get_character_id(user_input)

        print("\nDownloading character...")
        ddb_data = download_character(character_id)

        print("Converting character...")
        converted_character = convert_character(ddb_data)

        character_name = converted_character.get(
            "name",
            f"character_{character_id}",
        )

        safe_name = "".join(
            character
            if character.isalnum() or character in (" ", "-", "_")
            else "_"
            for character in character_name
        ).strip()

        if not safe_name:
            safe_name = f"character_{character_id}"

        output_filename = f"{safe_name}_{character_id}.json"
        output_path = Path(__file__).parent / output_filename

        save_converted_character(
            converted_character,
            output_path,
        )

        print("\nCharacter downloaded and converted successfully.")
        print(f"Saved to: {output_path.resolve()}")

    except (
        ValueError,
        requests.exceptions.RequestException,
        KeyError,
        RuntimeError,
        OSError,
    ) as error:
        print(f"\n{failure_message(error)}")


if __name__ == "__main__":
    main()
