# Program to check pass or fail

passing_marks = int(input("Enter passing marks: "))
obt_marks = int(input("Enter obtained marks: "))

if obt_marks >= passing_marks:
    print("Congratulations! You are passed.")
else:
    print("Better luck next time.")