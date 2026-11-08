
from pydantic import BaseModel, Field, ConfigDict
from decimal import Decimal


class AccountCreate(BaseModel):
    owner_name: str = Field(min_length=2, max_length=100)
    pin: str = Field(pattern=r"^\d{4}$")
    currency: str = "AZN"


class AccountResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    account_number: str
    owner_name: str
    balance: Decimal
    currency: str
    is_active: bool


class TransactionRequest(BaseModel):
    pin: str = Field(pattern=r"^\d{4}$")
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)


class BalanceResponse(BaseModel):
    account_number: str
    balance: Decimal
    currency: str


class TransactionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    account_id: int
    transaction_type: str
    amount: Decimal
    currency: str
    balance_after: Decimal
    created_at: object
