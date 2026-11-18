---
title: "作业记录"
published: 2026-11-14
draft: false
hidden: false
description: "写作未必能解决问题，但它能让一段模糊的感受有机会被看见。"
image: "/images/banner.jpeg"
tags: ["随笔","记录","思考"]
category: "随笔"
lang: "zh_CN"
---

# 如有错误，喂给ai
## 1.下三角图形

#include <stdio.h>

int main(){
    int a, b, i, d;
    printf("请输入字符与行数：");
    scanf("%c %d",&a, &b);
    for ( i = 1; i <= b ; i++)
    {
        for ( d = 1; d <= i; d++)
        {
            printf("%c",a);
        }
        printf("\n");
    }
}


## 2.上三角复合图形

#include <stdio.h>

int main(){
    int a, b, i, d, j;
    printf("请输入字符与行数：");
    scanf("%c %d",&a, &b);
    for ( i = 1; i <= b ; i++)
    {
        for (j = 0; j < i ; j++)
        {
            printf(" ");
        }
        
        for ( d = b; i <= d; d--)
        {
            printf("%c",a);
        }
        printf("\n");
    }
}

## 3.等腰三角图形

#include <stdio.h>

int main(){
    int a, b, i, d, j;
    printf("请输入字符与行数：");
    scanf("%c %d",&a, &b);
    
    for ( i = 0; i < b; i++)
    {
        for ( j = b ; j > i ; j-- )
        {
            printf(" ");
        }

        printf("%c",a);

        for ( d = 0; d < i; d++)
        {
            printf("%c%c", a, a);
        }
        printf("\n");
    }    
}

## 4.字母A图形

#include <stdio.h>

int main(){
    int a, b, i, d, j;
    printf("请输入字符与行数：");
    scanf("%c %d",&a, &b);
    for ( i = 0; i < b; i++)
    {
        for ( j = b ; j > i ; j-- )
        {
            printf(" ");
        }

        printf("%c",a);

        for ( d = 0; d < i; d++)
        {
            if (d == 0 && i == 1 )
            {
                printf(" %c", a);
            }
            else if ((i == 3 && d == 0) || (i == 3 && d == 1) )
            {
                printf("  ");
            }
            else if (i == 3 && d == 2)
            {
                printf(" %c", a);
            }
            
            else
            {
            printf("%c%c", a, a);
            }
        }
        printf("\n");
    }    
}

## 5.素数问题
#include <stdio.h>
#include <math.h>

int su_shu (int i){
    if (i == 2)
    {
        return 1;
    }
    if (i == 0 || i == 1)
    {
        return 0;
    }

    int x = sqrt(i);
        
    for (int a = 2; a <= x; a++){
        if (i % a == 0)
            {
                return 0;
            } 
    }
    return 1;
}

int main(){
    int count = 0;
    int m, n, i, a;
    printf("请输入m与n的值：");
    scanf("%d %d",&m, &n);
    for ( i = m ; i <= n; i++)
    {
        if (su_shu(i))
        {
            printf("%-8d",i);
            count++;
            if (count % 3 == 0)
            {
                printf("\n");
            }
        }
    }
    return 0;    
}


## 6.求最大数
#include <stdio.h>

int main(){
    int a,max;
    max = 0;
    printf("请输入数字，以0结束：\n");
    while (scanf("%d",&a) == 1 && a > 0)
    {
        if (a > max)
        {
            max = a;
        }
    }
    printf("最大值为：%d",max);
    return 0;
}

## 7. 水仙花数
#include <stdio.h>
#include <math.h>

int i, x, m, n, ge, shi, bai, a;
int shui_xian (int i){
    if (m < 100) return 0;
    if (m > n) return 0;
    ge = i % 10;
    shi = (i / 10) % 10;
    bai = i / 100;
    int x = pow(bai, 3) + pow (shi, 3) + pow (ge, 3);
    
    for ( a = m; a < n; a++)
    {
        if (x == i)
        {
            return 1;
        }
    }
    return 0;
    
}    
  

int main (){
    printf("请输入m与n：");
    scanf("%d %d",&m, &n);
    for ( i = (m + 1); i < n; i++)
    {
        if (shui_xian(i))
        {
            printf("%-5d",i);
        }  
    } 
    return 0;   
}

## 8.最大公约数
#include <stdio.h>

//除法

int gcd(int a, int b)
{
    if (a < 0) a = -a;
    if (b < 0) b = -b;

    while (b != 0)
    {
        int t = a % b;
        a = b;
        b = t;
    }
    return a;
}


int yue_shu(int a, int b)
{
    if (a < 0) a = -a;          
    if (b < 0) b = -b;
    if (a == 0) return b;       
    if (b == 0) return a;
   
    //相减的关键在于大的减去小的，最终让大的等于小的数

    while (a != b)             
    {
        if (a > b)
            a = a - b;          
        else
            b = b - a;
    }
    return a;
}

int main()
{
    int a, b;
    printf("请输入两个数字：");
    scanf("%d %d",&a, &b);
    printf("最大公约数为：%d", yue_shu(a, b));
    return 0;
}

## 9. 完数

#include <stdio.h>

int main(){
    int a, sum, i, j;
    printf("请输入数字：");
    scanf("%d",&a);
    for (i = 1; i < a; i++)
    {
        sum = 0;
        for ( j = 2; j < i; j++)
        {
            if (i % j == 0)
            {
                sum = sum + j;
            }
        }
        if (sum == i - 1 && sum != 0)
        {
            printf("%d是完数\n",i);
        } 
    }
}


## 10.分苹果
#include <stdio.h>
int main(){
    int x, sum;
    printf("请输入小朋友数：");
    scanf("%d",&x);
    sum = ((1 + x)*x)/2;
    printf("苹果总数：%d",sum);
}

## 11.百元买百鸡
#include <stdio.h>
int main(){
    int money, xiao, mu, gong;
    money = 100;
    for ( gong = 1; gong < 20; gong++)
    {
        for ( mu = 1; mu < 33; mu++)
        {
            for ( xiao = 3 ; xiao < 100; xiao = xiao + 3)
            {
                if (xiao / 3 + mu * 3 + gong * 5 == money && xiao + mu + gong == 100)
                {
                    printf("公鸡%d，母鸡%d，小鸡%d",gong, mu, xiao);
                    printf("\n");
                }   
            }   
        }   
    }
}

## 12.简易数制转换
#include <stdio.h>
int main(){
    int a, x, y;
    printf("请输入：\n");
    scanf("%d",&a);
    printf("逆序输出为：");
    while (a > 0)
    {
        y = a % 8;
        a = a / 8;
        printf("%d",y);
    }
}

## 13.数字组合
#include <stdio.h>
int main(){
    int a, b, c, sum;
    for ( a = 1; a <= 4; a++)
    {
        for ( b = 1; b <= 4; b++)
        {
            for ( c = 1; c <= 4; c++)
            {
                if (a != b && b != c && a != c)
                {
                    sum = a*100 + b * 10 + c;
                    printf("%d\n",sum);
                }   
            }   
        }   
    }
}
## 14.两人搬砖
#include <stdio.h>
int main(){
    int x, y;
    for ( x = 14; x < 245; x += 14)
    {
        for ( y = 17; y < 245; y += 17)
        {
            if (x + y == 245)
            {
                printf("甲：%d，乙：%d",x, y);
            }
        }   
    }
}

## 15.找数字
#include <stdio.h>
int main(){
    int i, j;
    int count = 0;
    for (i = 1; i < 600; i++)
    {
        if (i % 3 == 0 && ((i % 10 == 5) || (i / 100 == 5) || ((i / 10) % 10 == 5)))
        {
            printf("%-5d",i);
            count++;
            if (count % 4 == 0)
            {
                printf("\n");
            }   
        }   
    }   
}
